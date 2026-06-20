/**
 * Video Editor - Premiere Pro ExtendScript
 * Runs inside Premiere's scripting engine to access timeline data.
 */

function httpGet(path) {
    try {
        var conn = new Socket();
        conn.timeout = 30;
        if (!conn.open("127.0.0.1:8456", "binary")) {
            return '{"error":"Cannot connect to backend"}';
        }
        conn.write("GET " + path + " HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
        var response = "";
        while (!conn.eof) {
            response += conn.read(65536);
        }
        conn.close();
        var idx = response.indexOf("\r\n\r\n");
        if (idx >= 0) {
            return response.substring(idx + 4);
        }
        return response;
    } catch (e) {
        return '{"error":"' + e.message + '"}';
    }
}

function analyzeVideo(videoPath, style) {
    var path = "/analyze?video_path=" + encodeURIComponent(videoPath) + "&style=" + encodeURIComponent(style) + "&whisper_model=medium";
    return httpGet(path);
}

function exportXML() {
    return httpGet("/export-xml");
}

function getJobStatus() {
    return httpGet("/job-status");
}

function getSelectedClipPath() {
    // Legacy entry point — still returns just the path, used by older
    // callers that don't care about trim info. Defers to the new
    // getSelectedClipInfo() and pulls the path out of the JSON.
    try {
        var info = getSelectedClipInfo();
        if (!info) return "";
        var parsed = JSON.parse(info);
        return (parsed && parsed.path) || "";
    } catch (e) {
        return "";
    }
}

// Returns a JSON blob describing the currently-selected timeline clip:
//   { path, inPoint, outPoint, duration, trimmed }
// inPoint / outPoint are seconds INTO the source media file. `trimmed`
// is true iff the in/out range is a strict subset of the source's full
// duration — that's the trigger for /analyze to pre-extract just the
// trimmed range before running the SmartCut pipeline.
function getSelectedClipInfo() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return "";

        var pickedClip = null;
        for (var t = 0; t < seq.videoTracks.numTracks && !pickedClip; t++) {
            var track = seq.videoTracks[t];
            for (var c = 0; c < track.clips.numItems; c++) {
                var clip = track.clips[c];
                if (clip.isSelected()) { pickedClip = clip; break; }
            }
        }
        // Fallback: first clip on V1 if nothing's selected
        if (!pickedClip && seq.videoTracks.numTracks > 0) {
            var t0 = seq.videoTracks[0];
            if (t0.clips.numItems > 0) pickedClip = t0.clips[0];
        }
        if (!pickedClip) return "";

        var item = pickedClip.projectItem;
        if (!item) return "";
        var path = item.getMediaPath();
        if (!path) return "";

        // Time objects can expose either `.seconds` (new Premiere) or
        // `.ticks` (older). Read both defensively.
        function _toSec(t) {
            if (!t) return null;
            if (typeof t.seconds === "number") return t.seconds;
            if (typeof t.ticks !== "undefined") {
                var ticks = parseFloat(t.ticks);
                if (!isNaN(ticks)) return ticks / 254016000000;
            }
            return null;
        }
        var inSec = _toSec(pickedClip.inPoint);
        var outSec = _toSec(pickedClip.outPoint);
        var durSec = _toSec(pickedClip.duration);

        // Probe the SOURCE media's true duration via the projectItem if
        // possible, so we can detect "no trim" vs "trimmed".
        var sourceDur = null;
        try {
            var fp = item.getFootageInterpretation
                ? null   // not directly useful for duration
                : null;
            // Source duration sometimes available on projectItem
            if (item.getOutPoint) {
                sourceDur = _toSec(item.getOutPoint());
            }
        } catch (e) {}

        var trimmed = false;
        if (inSec !== null && outSec !== null) {
            // A clip is "trimmed" when it doesn't span its source from 0
            // to source-duration. Without sourceDur we fall back to a
            // simple in>0.1 check.
            if (sourceDur && sourceDur > 0) {
                if (inSec > 0.1 || outSec < sourceDur - 0.1) trimmed = true;
            } else if (inSec > 0.1) {
                trimmed = true;
            }
        }

        // Effekt-Check: hat der Clip mehr als die default-Komponenten?
        // Default-Video-Komponenten in Premiere: Bewegung (Motion),
        // Deckkraft (Opacity), Zeit-Neuzuordnung (Time Remapping).
        // Plus: prüfen ob "Bewegung" oder andere Defaults nicht-default
        // Werte haben (z.B. Position/Scale verändert).
        var hasEffects = false;
        try {
            if (pickedClip.components) {
                // Mehr als 3 Komponenten = User hat einen extra Effekt
                // hinzugefügt (z.B. "Zuschneiden", Color Grading).
                if (pickedClip.components.numItems > 3) hasEffects = true;
                // Auch wenn nur 3, könnte "Bewegung" modifiziert sein.
                // Wir prüfen die Properties: wenn nicht default → hasEffects.
                if (!hasEffects) {
                    for (var ci = 0; ci < pickedClip.components.numItems; ci++) {
                        var comp = pickedClip.components[ci];
                        if (!comp || !comp.properties) continue;
                        for (var pi = 0; pi < comp.properties.numItems; pi++) {
                            var prop = comp.properties[pi];
                            if (!prop) continue;
                            try {
                                // Keyframes drauf? → Effekt
                                if (prop.areKeyframesSupported &&
                                    prop.areKeyframesSupported() &&
                                    prop.getKeys &&
                                    prop.getKeys().length > 0) {
                                    hasEffects = true; break;
                                }
                            } catch (e1) {}
                        }
                        if (hasEffects) break;
                    }
                }
            }
        } catch (eEf) {}

        // Sequence coordinates (für Pre-Render Work Area)
        var clipStartSec = _toSec(pickedClip.start);
        var clipEndSec = _toSec(pickedClip.end);

        var obj = {
            path: path,
            inPoint: inSec,
            outPoint: outSec,
            duration: durSec,
            sourceDuration: sourceDur,
            trimmed: trimmed,
            hasEffects: hasEffects,
            clipStart: clipStartSec,
            clipEnd: clipEndSec,
        };
        // ExtendScript JSON: build by hand since older Premieres lack
        // a global JSON. Simple values only.
        function _q(v) {
            if (v === null || v === undefined) return "null";
            if (typeof v === "number") return String(v);
            if (typeof v === "boolean") return v ? "true" : "false";
            // String — escape quotes/backslashes
            var s = String(v).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
            return "\"" + s + "\"";
        }
        var parts = [];
        for (var k in obj) parts.push("\"" + k + "\":" + _q(obj[k]));
        return "{" + parts.join(",") + "}";
    } catch (e) {
        return "";
    }
}

// ─── Auto-Pre-Render ──────────────────────────────────────────────
// Wenn der User Effekte auf den Clip gesetzt hat (Crop, Color, Masken,
// Bewegungs-Änderungen etc.), würde das Plugin sonst die Roh-Datei
// lesen und die Effekte ignorieren. Pre-Render macht: setze Sequence-
// In/Out auf den Clip-Bereich, exportiere via Premiere selbst (alle
// Effekte werden gebakt), schicke die Temp-mp4 ans Plugin statt der
// Roh-Datei.

function _findH264PresetOnDisk() {
    // Premiere shipped seit Version 2020+ eine "H.264 MP4"-Vorgabe als
    // Proxy-Preset im App-Bundle. Wir suchen die in den /Applications-
    // Pfaden. Damit muss der User KEIN eigenes Preset speichern.

    // Subpaths innerhalb der Premiere-App
    // WICHTIG: H.264-Presets ZUERST — sind hardware-beschleunigt und
    // 3-5× schneller als ProRes beim Pre-Render, der nur ein Zwischen-
    // Schritt ist (wird im SmartCut sowieso nochmal verarbeitet). Match-
    // Source-Presets enthalten Audio. Die /Proxy/-Presets enthalten KEIN
    // Audio und kommen erst als letzte Notlösung.
    var subpaths = [
        // H.264 hardware-accelerated, mit Audio
        "/Contents/Settings/IngestPresets/Transcode/Match Source - H.264 High Bitrate.epr",
        "/Contents/MediaIO/systempresets/3F3F3F3F_4D6F6F56/H264 Match Source - High bitrate.epr",
        // ProRes als Fallback (langsam, große Files, aber überall verfügbar)
        "/Contents/Settings/EncoderPresets/ConsolidateAndTranscode/Match Source - Apple ProRes 422 LT.epr",
        "/Contents/Settings/EncoderPresets/Match Source - Apple ProRes 422 LT.epr",
        "/Contents/Settings/EncoderPresets/ConsolidateAndTranscode/Match Source - Apple ProRes 422.epr",
        "/Contents/Settings/EncoderPresets/Match Source - Apple ProRes 422.epr",
        // Proxy presets letzte Notlösung — KEIN Audio, Whisper sieht
        // Stille, Job crasht. Nur nehmen wenn sonst nichts da ist.
        "/Contents/Settings/IngestPresets/Proxy/02_H.264 MP4.epr",
        "/Contents/Settings/IngestPresets/Proxy/01_H.264 MOV.epr",
    ];

    // Versionen, die wir abfragen — Premiere benennt seine Apps so:
    //   /Applications/Adobe Premiere Pro 2024/Adobe Premiere Pro 2024.app
    //   /Applications/Adobe Premiere Pro 2025/Adobe Premiere Pro 2025.app
    //   ... (oder 25.x, 24.x bei älteren)
    var versionLabels = [
        "2028", "2027", "2026", "2025", "2024", "2023", "2022", "2021", "2020",
    ];
    for (var vi = 0; vi < versionLabels.length; vi++) {
        var v = versionLabels[vi];
        var appPath = "/Applications/Adobe Premiere Pro " + v
            + "/Adobe Premiere Pro " + v + ".app";
        // .app is technically a folder but ExtendScript inconsistently
        // classifies it — testing the inner preset directly avoids
        // having to inspect the bundle.
        for (var si = 0; si < subpaths.length; si++) {
            var candidate = appPath + subpaths[si];
            if ((new File(candidate)).exists) return candidate;
        }
    }

    // Fallback: durchsuche /Applications für irgendeinen Premiere-Folder
    // (für unbekannte Versionsbezeichner).
    try {
        var allInApps = new Folder("/Applications").getFiles();
        if (allInApps) {
            for (var fi = 0; fi < allInApps.length; fi++) {
                var item = allInApps[fi];
                var iName = item.name || "";
                if (iName.indexOf("Adobe Premiere Pro") !== 0) continue;
                // Beide Möglichkeiten checken: direkt .app oder Container-Folder
                var basePath = item.fsName;
                for (var si2 = 0; si2 < subpaths.length; si2++) {
                    var c1 = basePath + subpaths[si2];
                    if ((new File(c1)).exists) return c1;
                    // Container folder → "Adobe Premiere Pro YYYY.app" drin
                    var inner = basePath + "/" + iName + ".app" + subpaths[si2];
                    if ((new File(inner)).exists) return inner;
                }
            }
        }
    } catch (eApps) {}

    // Fallback: User-Custom-Presets (falls User schon mal gespeichert hat)
    try {
        var docFolder = new Folder(Folder.myDocuments.fsName + "/Adobe/Premiere Pro");
        if (docFolder.exists) {
            var versions = docFolder.getFiles(function(f) {
                return f instanceof Folder;
            });
            for (var vi = 0; vi < versions.length; vi++) {
                var profiles = versions[vi].getFiles(function(f) {
                    return f instanceof Folder && f.name.indexOf("Profile-") === 0;
                });
                for (var pi = 0; pi < profiles.length; pi++) {
                    var custom = new Folder(
                        profiles[pi].fsName + "/Settings/Custom"
                    );
                    if (!custom.exists) continue;
                    var eprs = custom.getFiles("*.epr");
                    if (eprs && eprs.length > 0) return eprs[0].fsName;
                }
            }
        }
    } catch (eUser) {}

    return null;
}

// Wrapper für das Panel — gibt den auto-gefundenen Preset-Pfad zurück,
// oder leeren String wenn keiner gefunden.
function findBuiltInPreset() {
    var p = _findH264PresetOnDisk();
    return p || "";
}

function pickH264Preset() {
    // File-Picker für eine .epr-Datei. Damit kann der User einmalig
    // sein bevorzugtes Export-Preset wählen (das Panel cached den Pfad
    // in localStorage).
    try {
        var f = File.openDialog(
            "Wähle eine H.264 Export-Vorgabe (.epr)",
            "Vorgaben:*.epr"
        );
        if (f) return f.fsName;
    } catch (e) {}
    return "";
}

function renderSelectedClipToTemp(presetPath) {
    try {
        if (!presetPath) return "error: no preset";
        var presetFile = new File(presetPath);
        if (!presetFile.exists) return "error: preset not found: " + presetPath;

        var seq = app.project.activeSequence;
        if (!seq) return "error: no active sequence";

        // Find selected clip
        var pickedClip = null;
        for (var t = 0; t < seq.videoTracks.numTracks && !pickedClip; t++) {
            var track = seq.videoTracks[t];
            for (var c = 0; c < track.clips.numItems; c++) {
                var clip = track.clips[c];
                if (clip.isSelected()) { pickedClip = clip; break; }
            }
        }
        if (!pickedClip && seq.videoTracks.numTracks > 0) {
            var t0 = seq.videoTracks[0];
            if (t0.clips.numItems > 0) pickedClip = t0.clips[0];
        }
        if (!pickedClip) return "error: no selected clip";

        function _sec(timeObj) {
            if (!timeObj) return 0;
            if (typeof timeObj.seconds === "number") return timeObj.seconds;
            if (typeof timeObj.ticks !== "undefined") {
                return parseFloat(timeObj.ticks) / 254016000000;
            }
            return 0;
        }

        var clipStart = _sec(pickedClip.start);
        var clipEnd = _sec(pickedClip.end);
        if (clipEnd <= clipStart) {
            return "error: invalid clip range";
        }

        // Save old In/Out so we can restore
        var oldIn = null, oldOut = null;
        try {
            if (seq.getInPointAsTime) oldIn = _sec(seq.getInPointAsTime());
            if (seq.getOutPointAsTime) oldOut = _sec(seq.getOutPointAsTime());
        } catch (eIO) {}

        // Set sequence In/Out to clip range
        try { seq.setInPoint(clipStart); } catch (eS1) {}
        try { seq.setOutPoint(clipEnd); } catch (eS2) {}

        // Output path: in stabilen User-Pfad statt /var/folders/ — der
        // tmp-Path hat manchmal Random-Komponenten die das Backend nicht
        // auflösen kann.
        var cacheDir = Folder.myDocuments.parent.fsName
            + "/Movies/Videos/.smartcut_plugin_cache";
        try {
            var cf = new Folder(cacheDir);
            if (!cf.exists) cf.create();
        } catch (eMk) {}
        // Lesbarer Dateiname: <SourceName>_SmartCut_HHMM.mp4 statt
        // prerender_TIMESTAMP. Source kommt vom projectItem.
        var srcName = "Clip";
        try {
            var item = pickedClip.projectItem;
            if (item && item.getMediaPath) {
                var rawPath = item.getMediaPath();
                if (rawPath) {
                    // basename, ohne .ext, Sonderzeichen raus, max 40 Zeichen
                    var base = rawPath.replace(/\\/g, "/").split("/").pop();
                    base = base.replace(/\.[^.]+$/, "");
                    base = base.replace(/[^A-Za-z0-9_-]+/g, "_");
                    base = base.substring(0, 40);
                    if (base.length) srcName = base;
                }
            }
        } catch (eN) {}
        var d = new Date();
        function _pad2(n) { return (n < 10 ? "0" + n : "" + n); }
        var stampHHMM = _pad2(d.getHours()) + _pad2(d.getMinutes());
        var outPath = cacheDir + "/" + srcName + "_SmartCut_" + stampHHMM + ".mp4";
        // Falls Datei bereits existiert (zweiter Run in derselben Minute):
        // Suffix _2, _3, ... anhängen damit nichts überschrieben wird.
        if ((new File(outPath)).exists) {
            for (var dupi = 2; dupi < 100; dupi++) {
                var alt = cacheDir + "/" + srcName + "_SmartCut_"
                    + stampHHMM + "_" + dupi + ".mp4";
                if (!(new File(alt)).exists) { outPath = alt; break; }
            }
        }

        // exportAsMediaDirect: workAreaType 1 = encode work area (In..Out)
        var ok = false;
        var errMsg = "";
        try {
            ok = seq.exportAsMediaDirect(outPath, presetPath, 1);
        } catch (eExp) {
            errMsg = eExp.message || String(eExp);
        }

        // Restore In/Out
        try {
            if (oldIn !== null) seq.setInPoint(oldIn);
            if (oldOut !== null) seq.setOutPoint(oldOut);
        } catch (eR) {}

        if (ok && (new File(outPath)).exists) {
            return "ok:" + outPath;
        }
        return "error: export failed" + (errMsg ? (" — " + errMsg) : "");
    } catch (e) {
        return "error: " + (e.message || String(e));
    }
}

function getTimelineFPS() {
    try {
        var seq = app.project.activeSequence;
        if (seq) {
            var ticks = seq.getSettings().videoFrameRate;
            // Ticks per second = 254016000000
            var fps = 254016000000 / ticks;
            return Math.round(fps * 100) / 100;
        }
    } catch (e) {}
    return 24;
}

// Globals for each processing run
var _currentBin = null;
var _currentSeqID = null;

function openCurrentSequence() {
    if (_currentSeqID) {
        app.project.openSequence(_currentSeqID);
        return "ok";
    }
    return "error:no_seq_id";
}

function createUniqueBin(clipName, styleName) {
    // Create bin named: "ClipName - Style"
    // Shorten clip name to keep it readable
    var shortName = clipName || "Edit";
    // Remove file extension
    var dotIdx = shortName.lastIndexOf(".");
    if (dotIdx > 0) shortName = shortName.substring(0, dotIdx);
    // Truncate long names
    if (shortName.length > 25) shortName = shortName.substring(0, 25);

    var binName = shortName + " - " + (styleName || "Edit");

    // If bin with same name exists, add number
    var root = app.project.rootItem;
    var counter = 1;
    var finalName = binName;
    var exists = true;
    while (exists) {
        exists = false;
        for (var i = 0; i < root.children.numItems; i++) {
            if (root.children[i].name === finalName && root.children[i].type === 2) {
                exists = true;
                counter++;
                finalName = binName + " (" + counter + ")";
                break;
            }
        }
    }

    _currentBin = root.createBin(finalName);
    return _currentBin;
}

function importXMLSequence(xmlPath, clipName, styleName, preserveImportedDims) {
    try {
        // Verify file exists first
        var f = new File(xmlPath);
        if (!f.exists) {
            return "error: file not found: " + xmlPath;
        }

        // Save the active (source) sequence settings BEFORE import
        var sourceSeq = app.project.activeSequence;
        var sourceSettings = null;
        if (sourceSeq) {
            try {
                sourceSettings = sourceSeq.getSettings();
            } catch (e) {}
        }

        // Create unique bin named after clip + style
        var bin = createUniqueBin(clipName, styleName);

        // Collect ALL existing sequence IDs before import
        var oldIds = {};
        for (var j = 0; j < app.project.sequences.numSequences; j++) {
            oldIds[app.project.sequences[j].sequenceID] = true;
        }

        // Import into the bin
        var success = app.project.importFiles([xmlPath], true, bin, false);

        if (!success) {
            // Fallback: import to root
            success = app.project.importFiles([xmlPath]);
        }

        if (success) {
            // Give Premiere time to register the new sequence
            $.sleep(1000);

            // Find the NEW sequence by comparing IDs
            _currentSeqID = null;
            var seqCountAfter = app.project.sequences.numSequences;
            var foundMethod = "none";
            var newSeq = null;

            for (var q = 0; q < seqCountAfter; q++) {
                var seq = app.project.sequences[q];
                if (!oldIds[seq.sequenceID]) {
                    _currentSeqID = seq.sequenceID;
                    newSeq = seq;
                    foundMethod = "id_compare:" + seq.name;
                    break;
                }
            }

            // Fallback: search by name
            if (!_currentSeqID) {
                for (var q2 = seqCountAfter - 1; q2 >= 0; q2--) {
                    var seq2 = app.project.sequences[q2];
                    if (seq2.name.indexOf("SmartCut") === 0) {
                        _currentSeqID = seq2.sequenceID;
                        newSeq = seq2;
                        foundMethod = "name_match:" + seq2.name;
                        break;
                    }
                }
            }

            // Copy ALL sequence settings from original to prevent color/brightness shift.
            // FCP7 XML cannot specify Premiere-specific settings like working color space,
            // composite in linear color, maximum bit depth, etc. Applying the source
            // sequence's settings ensures the new sequence renders identically.
            //
            // BUT: when the XML defines its own dimensions (SmartCam reframe →
            // 1080×1920 portrait), copying the source sequence's settings
            // overrides those dimensions back to whatever the user's working
            // sequence was. So if preserveImportedDims is set, preserve the
            // imported sequence's width/height/framerate but still copy the
            // remaining color-related settings.
            if (newSeq && sourceSettings) {
                try {
                    if (preserveImportedDims) {
                        var importedSettings = newSeq.getSettings();
                        var w = importedSettings.videoFrameWidth;
                        var h = importedSettings.videoFrameHeight;
                        var fr = importedSettings.videoFrameRate;
                        // Apply the source's color etc., then restore dims
                        newSeq.setSettings(sourceSettings);
                        var fixed = newSeq.getSettings();
                        fixed.videoFrameWidth = w;
                        fixed.videoFrameHeight = h;
                        fixed.videoFrameRate = fr;
                        newSeq.setSettings(fixed);
                    } else {
                        newSeq.setSettings(sourceSettings);
                    }
                } catch (e) {
                    // Settings copy failed — continue without it
                }
            }

            // Open the sequence
            if (_currentSeqID) {
                app.project.openSequence(_currentSeqID);
            }

            return "ok:" + foundMethod + ":seqs_after=" + seqCountAfter;
        }

        return "error: import returned false";
    } catch (e) {
        return "error: " + e.message;
    }
}

// Set a clip's blend mode to Screen so its black background composes as
// transparent against V1. Walks the clip's components looking for the
// Opacity component (where Premiere stashes the Blend Mode property).
// Screen = enum value 11 in Premiere's blend-mode list.
function _setBlendModeScreen(clip) {
    try {
        for (var ci = 0; ci < clip.components.numItems; ci++) {
            var comp = clip.components[ci];
            if (!comp.displayName) continue;
            if (comp.displayName === "Opacity" ||
                comp.matchName === "AE.ADBE Opacity") {
                for (var pi = 0; pi < comp.properties.numItems; pi++) {
                    var prop = comp.properties[pi];
                    if (prop.displayName === "Blend Mode" ||
                        prop.displayName === "Mischmodus") {
                        try { prop.setValue(11, true); } catch (e1) {
                            try { prop.setValue(11); } catch (e2) {}
                        }
                        return true;
                    }
                }
            }
        }
    } catch (e) {}
    return false;
}

// Import the subtitle overlay into the current SmartCut sequence on V2
// and switch its blend mode to Screen. Called after importXMLSequence.
function importOverlayOnV2(overlayPath, clipName) {
    try {
        var f = new File(overlayPath);
        if (!f.exists) {
            return "error: overlay not found: " + overlayPath;
        }

        // Find the target sequence (created by the recent XML import)
        var seq = null;
        if (_currentSeqID) {
            for (var si = 0; si < app.project.sequences.numSequences; si++) {
                if (app.project.sequences[si].sequenceID === _currentSeqID) {
                    seq = app.project.sequences[si];
                    break;
                }
            }
        }
        if (!seq) {
            var active = app.project.activeSequence;
            if (active && active.name.indexOf("SmartCut") === 0) {
                seq = active;
            }
        }
        if (!seq) return "error:no_matching_seq";
        app.project.openSequence(seq.sequenceID);

        // Import overlay into the same bin used for the source clip if we
        // can find it; otherwise fall back to project root.
        var bin = app.project.rootItem;
        try {
            for (var bi = 0; bi < app.project.rootItem.children.numItems; bi++) {
                var item = app.project.rootItem.children[bi];
                if (item.type === ProjectItemType.BIN &&
                    item.name.indexOf(clipName || "") === 0) {
                    bin = item;
                    break;
                }
            }
        } catch (e) {}

        var beforeCount = bin.children.numItems;
        var ok = app.project.importFiles([overlayPath], true, bin, false);
        if (!ok) return "error: overlay import failed";

        // Find the newly imported overlay project item
        var overlayName = overlayPath.split("/").pop().split("\\").pop();
        var overlayItem = null;
        for (var i = bin.children.numItems - 1; i >= 0; i--) {
            if (bin.children[i].name === overlayName) {
                overlayItem = bin.children[i];
                break;
            }
        }
        if (!overlayItem) return "error:overlay_not_found_in_bin";

        // Make sure a V2 track exists
        var tracks = seq.videoTracks;
        if (tracks.numTracks < 2) {
            // Premiere ExtendScript can't add tracks directly; the user
            // gets a sequence with V1 only and the overlay would be
            // placed on V1 instead. Surface this so the panel can warn.
            return "error:no_v2_track";
        }
        var v2 = tracks[1];

        // Place overlay at the start of the timeline (time 0)
        var inserted = v2.insertClip(overlayItem, 0);
        if (inserted === false) {
            // Some Premiere versions return undefined on success — only
            // hard `false` indicates failure.
            return "error: insertClip returned false";
        }

        // Set the new clip's blend mode to Screen so the overlay's black
        // background becomes transparent and only the subtitle text shows
        // over V1. Best-effort — different Premiere versions expose the
        // blend-mode property differently, so we silently fall back to
        // Normal if it doesn't take.
        try {
            // Locate the freshly placed clip on V2.
            var newClip = null;
            for (var ci = 0; ci < v2.clips.numItems; ci++) {
                var cc = v2.clips[ci];
                if (cc.projectItem && cc.projectItem.name === overlayName) {
                    newClip = cc;
                    break;
                }
            }
            if (newClip) {
                _setBlendModeScreen(newClip);
            }
        } catch (e) {
            // best-effort
        }
        return "ok";
    } catch (e) {
        return "error: " + e.message;
    }
}

function applyVideoEditorResult(xmlContent) {
    try {
        // Write XML to temp file
        var tmpPath = Folder.temp.fsName + "/video_editor_export.xml";
        var f = new File(tmpPath);
        f.open("w");
        f.write(xmlContent);
        f.close();

        // Import into Premiere as new sequence
        var success = app.project.importFiles([tmpPath], true, app.project.rootItem, false);

        return success ? "ok" : "error: import failed";
    } catch (e) {
        return "error: " + e.message;
    }
}

function importCaptions(srtPath) {
    try {
        var f = new File(srtPath);
        if (!f.exists) {
            return "error: SRT file not found: " + srtPath;
        }

        // Find the target sequence
        var seq = null;
        if (_currentSeqID) {
            for (var si = 0; si < app.project.sequences.numSequences; si++) {
                if (app.project.sequences[si].sequenceID === _currentSeqID) {
                    seq = app.project.sequences[si];
                    break;
                }
            }
        }
        if (!seq) {
            var active = app.project.activeSequence;
            if (active && active.name.indexOf("SmartCut") === 0) {
                seq = active;
            }
        }
        if (!seq) return "error:no_matching_seq";

        // Open the sequence first
        app.project.openSequence(seq.sequenceID);

        // Import SRT into the project (needed as project item for createCaptionTrack)
        var root = app.project.rootItem;
        var countBefore = root.children.numItems;
        var success = app.project.importFiles([srtPath], true, root, false);
        if (!success) return "error: caption import failed";

        // Find the just-imported SRT item
        var srtName = srtPath.split("/").pop().split("\\").pop();
        var srtItem = null;
        for (var i = root.children.numItems - 1; i >= countBefore - 1 && i >= 0; i--) {
            if (root.children[i].name === srtName) {
                srtItem = root.children[i];
                break;
            }
        }
        if (!srtItem) return "error:srt_not_found_in_project";

        // Check if sequence already has caption tracks — avoid duplicates
        try {
            if (seq.captionTracks && seq.captionTracks.numTracks > 0) {
                return "ok:already_has_captions";
            }
        } catch (e) { /* captionTracks API may not exist in older versions */ }

        // Create caption track
        try {
            seq.createCaptionTrack(srtItem, 0);
        } catch (ce) {
            return "error:createCaptionTrack:" + ce.message;
        }

        return "ok";
    } catch (e) {
        return "error: " + e.message;
    }
}

function addMogrtSubtitles(mogrtPath, subtitlesJSON) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return "error:no_seq";

        var f = new File(mogrtPath);
        if (!f.exists) return "error:mogrt_not_found:" + mogrtPath;

        var subs;
        try { subs = JSON.parse(subtitlesJSON); }
        catch (e) { return "error:bad_json:" + e.message; }

        var TICKS_PER_SECOND = 254016000000;
        var vidTrack = 1; // V2
        var audTrack = 0;
        var placed = 0;
        var errors = [];

        for (var i = 0; i < subs.length; i++) {
            var sub = subs[i];
            var startTicks = String(Math.round(sub.start * TICKS_PER_SECOND));

            var trackItem = seq.importMGT(mogrtPath, startTicks, vidTrack, audTrack);
            if (!trackItem) {
                errors.push("null@" + i);
                continue;
            }

            // Adjust end time for correct duration
            try {
                var endTime = new Time();
                endTime.seconds = sub.end;
                trackItem.end = endTime;
            } catch (te) {}

            // Set text via MOGRT component
            try {
                var comp = trackItem.getMGTComponent();
                if (comp && comp.properties) {
                    var textParam = comp.properties.getParamForDisplayName("Source Text");
                    if (textParam) {
                        var val = textParam.getValue();
                        if (typeof val === "string" && val.charAt(0) === "{") {
                            var obj = JSON.parse(val);
                            obj.textEditValue = sub.text.toUpperCase();
                            if (obj.fontTextRunLength !== undefined) {
                                obj.fontTextRunLength = sub.text.length;
                            }
                            textParam.setValue(JSON.stringify(obj), true);
                        } else {
                            textParam.setValue(sub.text.toUpperCase(), true);
                        }
                    }
                }
            } catch (se) {
                errors.push("setText@" + i + ":" + se.message);
            }
            placed++;
        }

        var result = "ok:" + placed + "/" + subs.length;
        if (errors.length > 0) result += " errs:" + errors.join(",");
        return result;
    } catch (e) {
        return "error:" + e.message;
    }
}

function debugV2Clip() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return "no_seq";
        if (seq.videoTracks.numTracks < 2) return "no_V2_tracks:" + seq.videoTracks.numTracks;
        var v2 = seq.videoTracks[1];
        if (v2.clips.numItems === 0) return "no_clips_V2";

        var clip = v2.clips[0];
        var info = seq.name + "|" + seq.frameSizeHorizontal + "x" + seq.frameSizeVertical + "|comps:";
        for (var c = 0; c < clip.components.numItems; c++) {
            var comp = clip.components[c];
            info += comp.displayName + "[";
            for (var p = 0; p < Math.min(comp.properties.numItems, 6); p++) {
                info += comp.properties[p].displayName + ",";
            }
            info += "]|";
        }
        return info;
    } catch (e) {
        return "err:" + e.message;
    }
}

function styleSubtitles(yPercent) {
    try {
        // Find the Video Editor sequence (might not be activeSequence yet)
        var seq = null;
        for (var s = 0; s < app.project.sequences.numSequences; s++) {
            if (app.project.sequences[s].name.indexOf("SmartCut") === 0) {
                seq = app.project.sequences[s];
            }
        }
        if (!seq) seq = app.project.activeSequence;
        if (!seq) return "error:no_seq";

        // Make sure this sequence is active
        app.project.openSequence(seq.sequenceID);

        if (seq.videoTracks.numTracks < 2) return "error:tracks=" + seq.videoTracks.numTracks;
        var v2 = seq.videoTracks[1];
        if (v2.clips.numItems === 0) return "error:0clips_on_V2";

        var h = parseInt(seq.frameSizeVertical);
        var w = parseInt(seq.frameSizeHorizontal);

        // Text generator renders near top of frame
        // We shift the entire clip down so text appears at target Y%
        // Text top position in clip ≈ fontsize (roughly h*0.03 to h*0.05)
        var textTopInClip = h * 0.04;
        var targetY = h * (yPercent / 100.0);
        var newCenterY = (h / 2.0) + (targetY - textTopInClip);
        var centerX = w / 2.0;

        var count = 0;
        var dbg = "";

        for (var i = 0; i < v2.clips.numItems; i++) {
            var clip = v2.clips[i];
            var found = false;
            // Try ALL components — search by checking each property for "Position"
            for (var c = 0; c < clip.components.numItems; c++) {
                var comp = clip.components[c];
                for (var p = 0; p < comp.properties.numItems; p++) {
                    var prop = comp.properties[p];
                    var pName = prop.displayName;
                    if (pName === "Position") {
                        try {
                            prop.setValue([centerX, newCenterY], true);
                            count++;
                            found = true;
                        } catch (pe) {
                            dbg += "setErr:" + pe.message + ",";
                        }
                        break;
                    }
                }
                if (found) break;
            }
            // Debug first clip if not found
            if (i === 0 && !found) {
                for (var c2 = 0; c2 < clip.components.numItems; c2++) {
                    var cm = clip.components[c2];
                    dbg += cm.displayName + "[";
                    for (var p2 = 0; p2 < Math.min(cm.properties.numItems, 4); p2++) {
                        dbg += cm.properties[p2].displayName + ",";
                    }
                    dbg += "]";
                }
            }
        }
        return "ok:" + count + "/" + v2.clips.numItems + " y:" + Math.round(newCenterY) + " " + w + "x" + h + " " + dbg;
    } catch (e) {
        return "error:" + e.message;
    }
}

function rotateClips(degrees) {
    try {
        // Find the latest "Video Editor" sequence by name — most reliable method
        var seq = null;
        for (var s = app.project.sequences.numSequences - 1; s >= 0; s--) {
            if (app.project.sequences[s].name.indexOf("SmartCut") === 0) {
                seq = app.project.sequences[s];
                break;
            }
        }
        if (!seq) return "error:no_video_editor_seq";

        // Make sure this sequence is active
        app.project.openSequence(seq.sequenceID);

        if (seq.videoTracks.numTracks < 1) return "error:no_tracks";
        var v1 = seq.videoTracks[0];
        var count = 0;

        for (var i = 0; i < v1.clips.numItems; i++) {
            var clip = v1.clips[i];
            // Search ALL components for Rotation property
            var found = false;
            for (var c = 0; c < clip.components.numItems; c++) {
                var comp = clip.components[c];
                for (var p = 0; p < comp.properties.numItems; p++) {
                    var prop = comp.properties[p];
                    var pName = prop.displayName;
                    if (pName === "Rotation" || pName === "Drehung") {
                        prop.setValue(degrees, true);
                        count++;
                        found = true;
                        break;
                    }
                }
                if (found) break;
            }
        }
        return "ok:" + count + "/" + v1.clips.numItems + " seq:" + seq.name;
    } catch (e) {
        return "error:" + e.message;
    }
}

function addMarkersToTimeline(jsonStr) {
    try {
        var data = JSON.parse(jsonStr);
        var seq = app.project.activeSequence;
        if (!seq) return "error: no sequence";

        var markers = seq.markers;
        var subtitles = data.subtitles || [];

        for (var i = 0; i < subtitles.length; i++) {
            var sub = subtitles[i];
            var marker = markers.createMarker(sub.start);
            marker.name = sub.text;
            marker.end = sub.end;
            marker.comments = "SmartCut Subtitle";
            marker.setColorByIndex(3); // Green
        }

        return "ok: " + subtitles.length + " markers";
    } catch (e) {
        return "error: " + e.message;
    }
}
