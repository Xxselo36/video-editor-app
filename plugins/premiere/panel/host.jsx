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
    try {
        var seq = app.project.activeSequence;
        if (!seq) return "";

        // Check video tracks for selected clips
        for (var t = 0; t < seq.videoTracks.numTracks; t++) {
            var track = seq.videoTracks[t];
            for (var c = 0; c < track.clips.numItems; c++) {
                var clip = track.clips[c];
                if (clip.isSelected()) {
                    var item = clip.projectItem;
                    if (item) {
                        var path = item.getMediaPath();
                        if (path) return path;
                    }
                }
            }
        }

        // Fallback: return first clip on V1 if nothing selected
        if (seq.videoTracks.numTracks > 0) {
            var firstTrack = seq.videoTracks[0];
            if (firstTrack.clips.numItems > 0) {
                var firstClip = firstTrack.clips[0];
                var item = firstClip.projectItem;
                if (item) {
                    var path = item.getMediaPath();
                    if (path) return path;
                }
            }
        }

        return "";
    } catch (e) {
        return "";
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

function importXMLSequence(xmlPath, clipName, styleName) {
    try {
        // Verify file exists first
        var f = new File(xmlPath);
        if (!f.exists) {
            return "error: file not found: " + xmlPath;
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

            for (var q = 0; q < seqCountAfter; q++) {
                var seq = app.project.sequences[q];
                if (!oldIds[seq.sequenceID]) {
                    _currentSeqID = seq.sequenceID;
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
                        foundMethod = "name_match:" + seq2.name;
                        break;
                    }
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
