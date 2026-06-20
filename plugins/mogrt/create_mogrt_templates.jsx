/*
 * create_mogrt_templates.jsx
 *
 * After Effects ExtendScript — FULLY AUTOMATED MOGRT creation.
 * Creates 7 caption/subtitle template compositions, registers all editable
 * properties in the Essential Graphics Panel via addToMotionGraphicsTemplateAs(),
 * and exports each as a .mogrt file via exportAsMotionGraphicsTemplate().
 *
 * Usage:
 *   1. Open After Effects (AE 2018+ required for MOGRT scripting API)
 *   2. File > Scripts > Run Script File... > select this file
 *   3. Choose an output folder when prompted
 *   4. All 7 .mogrt files are exported automatically
 *
 * The exported .mogrt files can be installed in Premiere Pro:
 *   - Copy to: ~/Library/Application Support/Adobe/Common/Essential Graphics/
 *   - Or: Essential Graphics panel > Install Motion Graphics Template
 *
 * Exposed editable parameters in each MOGRT:
 *   - Source Text (the caption text)
 *   - Font Size
 *   - Text Color
 *   - Stroke Color
 *   - Stroke Width
 *   - Background Enabled (on/off)
 *   - Background Color
 *   - Background Opacity
 *   - Position Y
 */

(function () {
    // =========================================================================
    // TEMPLATE DEFINITIONS
    // =========================================================================
    var templates = [
        {
            name: "Clean",
            font: "Arial-Black",
            fontSize: 60,
            textColor: [1, 1, 1],           // white
            strokeColor: [0, 0, 0],         // black
            strokeWidth: 2,
            bgEnabled: true,
            bgColor: [0, 0, 0],
            bgOpacity: 60,                   // 60% opacity
            tracking: 0,
            posY: 384,                       // custom position
            justification: ParagraphJustification.CENTER_JUSTIFY
        },
        {
            name: "Karaoke",
            font: "Arial-Black",
            fontSize: 65,
            textColor: [1, 1, 1],           // white
            strokeColor: [0, 0, 0],
            strokeWidth: 2,
            bgEnabled: false,
            bgColor: [0, 0, 0],
            bgOpacity: 0,
            tracking: 0,
            posY: 540,                       // center
            justification: ParagraphJustification.CENTER_JUSTIFY
        },
        {
            name: "Classic",
            font: "Arial-Black",
            fontSize: 58,
            textColor: [1, 1, 1],           // white
            strokeColor: [0, 0, 0],
            strokeWidth: 3,
            bgEnabled: false,
            bgColor: [0, 0, 0],
            bgOpacity: 0,
            tracking: 0,
            posY: 918,                       // bottom
            justification: ParagraphJustification.CENTER_JUSTIFY
        },
        {
            name: "Boxed",
            font: "ArialMT",
            fontSize: 54,
            textColor: [1, 1, 1],           // white
            strokeColor: [0, 0, 0],
            strokeWidth: 0,
            bgEnabled: true,
            bgColor: [0, 0, 0],
            bgOpacity: 75,                   // 75% opacity
            tracking: 10,
            posY: 918,                       // bottom
            justification: ParagraphJustification.CENTER_JUSTIFY
        },
        {
            name: "Neon",
            font: "Arial-Black",
            fontSize: 64,
            textColor: [0, 1, 0.84],        // cyan #00ffd5
            strokeColor: [0, 1, 0.84],
            strokeWidth: 0,
            bgEnabled: false,
            bgColor: [0, 0, 0],
            bgOpacity: 0,
            tracking: 20,
            posY: 540,                       // center
            justification: ParagraphJustification.CENTER_JUSTIFY
        },
        {
            name: "Bold",
            font: "Impact",
            fontSize: 78,
            textColor: [1, 1, 1],           // white
            strokeColor: [0, 0, 0],
            strokeWidth: 2,
            bgEnabled: false,
            bgColor: [0, 0, 0],
            bgOpacity: 0,
            tracking: 20,
            posY: 540,                       // center
            justification: ParagraphJustification.CENTER_JUSTIFY
        },
        {
            name: "Minimal",
            font: "ArialMT",
            fontSize: 42,
            textColor: [0.71, 0.71, 0.71],  // light grey
            strokeColor: [0, 0, 0],
            strokeWidth: 1,
            bgEnabled: false,
            bgColor: [0, 0, 0],
            bgOpacity: 0,
            tracking: 30,
            posY: 972,                       // very bottom
            justification: ParagraphJustification.CENTER_JUSTIFY
        }
    ];

    // =========================================================================
    // HELPER: Add Expression Control effects to a layer
    // Returns references to the effect groups (not the value properties)
    // =========================================================================
    function addExpressionControls(layer) {
        var effects = layer.property("ADBE Effect Parade");

        var fx;
        fx = effects.addProperty("ADBE Slider Control");   fx.name = "Font Size";
        fx = effects.addProperty("ADBE Color Control");    fx.name = "Text Color";
        fx = effects.addProperty("ADBE Color Control");    fx.name = "Stroke Color";
        fx = effects.addProperty("ADBE Slider Control");   fx.name = "Stroke Width";
        fx = effects.addProperty("ADBE Checkbox Control"); fx.name = "Background Enabled";
        fx = effects.addProperty("ADBE Color Control");    fx.name = "Background Color";
        fx = effects.addProperty("ADBE Slider Control");   fx.name = "Background Opacity";
        fx = effects.addProperty("ADBE Slider Control");   fx.name = "Position Y";
    }

    // Helper: set value on expression control by effect index
    // Effect indices: 1=FontSize, 2=TextColor, 3=StrokeColor, 4=StrokeWidth,
    //                 5=BgEnabled, 6=BgColor, 7=BgOpacity, 8=PosY
    function setCtrlValue(layer, effectIndex, val) {
        layer.property("ADBE Effect Parade").property(effectIndex).property(1).setValue(val);
    }

    // =========================================================================
    // HELPER: Register properties in Essential Graphics Panel
    // Uses addToMotionGraphicsTemplateAs(comp, name) API
    // =========================================================================
    function registerEssentialProperties(comp, controlsNull, textLayer) {
        var results = [];

        // 1. Source Text — from the text layer directly
        var sourceTextProp = textLayer
            .property("ADBE Text Properties")
            .property("ADBE Text Document");
        if (sourceTextProp.canAddToMotionGraphicsTemplate(comp)) {
            sourceTextProp.addToMotionGraphicsTemplateAs(comp, "Source Text");
            results.push("Source Text");
        }

        // Register each expression control's value property (by effect index)
        // Index: 1=FontSize, 2=TextColor, 3=StrokeColor, 4=StrokeWidth,
        //        5=BgEnabled, 6=BgColor, 7=BgOpacity, 8=PosY
        var effects = controlsNull.property("ADBE Effect Parade");
        var names = ["Font Size", "Text Color", "Stroke Color", "Stroke Width",
                     "Background Enabled", "Background Color", "Background Opacity", "Position Y"];

        for (var ei = 0; ei < names.length; ei++) {
            var valProp = effects.property(ei + 1).property(1);
            if (valProp && valProp.canAddToMotionGraphicsTemplate(comp)) {
                valProp.addToMotionGraphicsTemplateAs(comp, names[ei]);
                results.push(names[ei]);
            }
        }

        return results;
    }

    // =========================================================================
    // MAIN: Create one template composition
    // =========================================================================
    function createTemplateComp(proj, tmpl) {
        var compW = 1920;
        var compH = 1080;
        var compFPS = 29.97;
        var compDur = 10; // seconds

        // --- Create Composition ---
        var comp = proj.items.addComp(
            "Caption_" + tmpl.name,
            compW, compH,
            1,        // pixel aspect ratio
            compDur,
            compFPS
        );

        // --- Create Controls Null ---
        var controlsNull = comp.layers.addNull();
        controlsNull.name = "Controls";
        controlsNull.property("ADBE Transform Group").property("ADBE Opacity").setValue(0);
        controlsNull.moveToBeginning();

        // Add expression controls
        addExpressionControls(controlsNull);

        // Set defaults via fresh property access (by effect index)
        setCtrlValue(controlsNull, 1, tmpl.fontSize);           // Font Size
        setCtrlValue(controlsNull, 2, tmpl.textColor);          // Text Color
        setCtrlValue(controlsNull, 3, tmpl.strokeColor);        // Stroke Color
        setCtrlValue(controlsNull, 4, tmpl.strokeWidth);        // Stroke Width
        setCtrlValue(controlsNull, 5, tmpl.bgEnabled ? 1 : 0); // Background Enabled
        setCtrlValue(controlsNull, 6, tmpl.bgColor);            // Background Color
        setCtrlValue(controlsNull, 7, tmpl.bgOpacity);          // Background Opacity
        setCtrlValue(controlsNull, 8, tmpl.posY || compH * 0.85); // Position Y

        // --- Create Background Shape Layer ---
        // IMPORTANT: Never cache property references in AE 2026 — always re-traverse from layer
        var bgLayer = comp.layers.addShape();
        bgLayer.name = "Background Box";

        // Build shape structure step by step (no cached refs)
        bgLayer.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group").name = "Rectangle";

        // Add rect path inside the group
        bgLayer.property("ADBE Root Vectors Group").property(1).property("ADBE Vectors Group")
            .addProperty("ADBE Vector Shape - Rect");

        // Set rect size + roundness (access fresh each time)
        bgLayer.property("ADBE Root Vectors Group").property(1).property("ADBE Vectors Group")
            .property("ADBE Vector Shape - Rect").property("ADBE Vector Rect Size").setValue([800, 80]);
        bgLayer.property("ADBE Root Vectors Group").property(1).property("ADBE Vectors Group")
            .property("ADBE Vector Shape - Rect").property("ADBE Vector Rect Roundness").setValue(12);

        // Add fill
        bgLayer.property("ADBE Root Vectors Group").property(1).property("ADBE Vectors Group")
            .addProperty("ADBE Vector Graphic - Fill");

        // Set fill color
        bgLayer.property("ADBE Root Vectors Group").property(1).property("ADBE Vectors Group")
            .property("ADBE Vector Graphic - Fill").property("ADBE Vector Fill Color").setValue(tmpl.bgColor);

        // Expressions: Background controlled by Controls null
        bgLayer.property("ADBE Transform Group").property("ADBE Opacity").expression =
            'var ctrl = thisComp.layer("Controls");\n' +
            'var enabled = ctrl.effect("Background Enabled")("Checkbox");\n' +
            'var opac = ctrl.effect("Background Opacity")("Slider");\n' +
            'enabled ? opac : 0;';

        bgLayer.property("ADBE Root Vectors Group").property(1).property("ADBE Vectors Group")
            .property("ADBE Vector Graphic - Fill").property("ADBE Vector Fill Color").expression =
            'thisComp.layer("Controls").effect("Background Color")("Color");';

        bgLayer.property("ADBE Root Vectors Group").property(1).property("ADBE Vectors Group")
            .property("ADBE Vector Shape - Rect").property("ADBE Vector Rect Size").expression =
            'var txt = thisComp.layer("Caption Text");\n' +
            'var r = txt.sourceRectAtTime(time, false);\n' +
            'var padX = 40;\n' +
            'var padY = 20;\n' +
            '[r.width + padX, r.height + padY];';

        bgLayer.property("ADBE Transform Group").property("ADBE Position").expression =
            'var txt = thisComp.layer("Caption Text");\n' +
            'var r = txt.sourceRectAtTime(time, false);\n' +
            'var txtPos = txt.transform.position;\n' +
            '[txtPos[0] + r.left + r.width/2, txtPos[1] + r.top + r.height/2];';

        // --- Create Text Layer ---
        var textLayer = comp.layers.addText("Caption Text Here");
        textLayer.name = "Caption Text";

        var textDoc = textLayer.property("ADBE Text Properties").property("ADBE Text Document").value;

        textDoc.font = tmpl.font;
        textDoc.fontSize = tmpl.fontSize;
        textDoc.fillColor = tmpl.textColor;
        textDoc.applyFill = true;
        textDoc.justification = tmpl.justification;
        textDoc.tracking = tmpl.tracking;

        if (tmpl.strokeWidth > 0) {
            textDoc.applyStroke = true;
            textDoc.strokeColor = tmpl.strokeColor;
            textDoc.strokeWidth = tmpl.strokeWidth;
            textDoc.strokeOverFill = false;
        } else {
            textDoc.applyStroke = false;
        }

        // Re-fetch textProp fresh to avoid stale reference
        textLayer.property("ADBE Text Properties").property("ADBE Text Document").setValue(textDoc);

        // Style expression on Source Text — controls font size, fill color, stroke from Controls layer
        // Uses AE 2020+ text.sourceText.style API (much cleaner than text animators)
        textLayer.property("ADBE Text Properties").property("ADBE Text Document").expression =
            'var ctrl = thisComp.layer("Controls");\n' +
            'var s = style;\n' +
            's = s.setFontSize(ctrl.effect("Font Size")("Slider"));\n' +
            's = s.setFillColor(ctrl.effect("Text Color")("Color"));\n' +
            's = s.setStrokeColor(ctrl.effect("Stroke Color")("Color"));\n' +
            's;';

        // Position Y expression
        textLayer.property("ADBE Transform Group").property("ADBE Position").expression =
            'var posY = thisComp.layer("Controls").effect("Position Y")("Slider");\n' +
            '[thisComp.width/2, posY];';

        // Layer ordering: Controls (top) > Caption Text > Background Box
        textLayer.moveAfter(controlsNull);

        // --- Register Essential Graphics Properties ---
        var registered = registerEssentialProperties(comp, controlsNull, textLayer);

        return {
            comp: comp,
            registered: registered
        };
    }

    // =========================================================================
    // RUN
    // =========================================================================

    // Ask user for output folder
    var outputFolder = Folder.selectDialog("Select output folder for .mogrt files");
    if (!outputFolder) {
        alert("Cancelled. No output folder selected.");
        return;
    }

    app.beginUndoGroup("Create MOGRT Templates");

    var proj = app.project;
    if (!proj) {
        proj = app.newProject();
    }

    // Create a folder in the project panel to organize templates
    var folder = proj.items.addFolder("Caption Templates");

    var results = [];
    var exportResults = [];

    for (var i = 0; i < templates.length; i++) {
        var tmpl = templates[i];
        // Re-fetch project reference each iteration (export invalidates refs)
        proj = app.project;
        var result = createTemplateComp(proj, tmpl);
        var comp = result.comp;
        // Re-fetch folder reference too
        for (var fi = 1; fi <= proj.numItems; fi++) {
            if (proj.item(fi).name === "Caption Templates" && proj.item(fi) instanceof FolderItem) {
                folder = proj.item(fi);
                break;
            }
        }
        comp.parentFolder = folder;

        // Set the MOGRT template name
        var mogrtName = "SmartCut_" + tmpl.name;
        comp.motionGraphicsTemplateName = mogrtName;

        // Export as .mogrt
        var outputPath = outputFolder.fsName + "/" + mogrtName + ".mogrt";
        var exportFile = new File(outputPath);
        var exported = false;

        try {
            exported = comp.exportAsMotionGraphicsTemplate(exportFile);
        } catch (e) {
            exported = false;
        }

        results.push({
            name: tmpl.name,
            registered: result.registered,
            exported: exported,
            path: outputPath
        });

        exportResults.push(mogrtName + ": " + (exported ? "OK" : "FAILED"));
    }

    app.endUndoGroup();

    // --- Summary ---
    var msg = "MOGRT Template Creation Complete\n";
    msg += "================================\n\n";

    for (var j = 0; j < results.length; j++) {
        var r = results[j];
        msg += "Template: " + r.name + "\n";
        msg += "  EGP properties: " + r.registered.join(", ") + "\n";
        msg += "  Export: " + (r.exported ? "SUCCESS" : "FAILED") + "\n";
        if (r.exported) {
            msg += "  Path: " + r.path + "\n";
        }
        msg += "\n";
    }

    msg += "Output folder: " + outputFolder.fsName + "\n\n";
    msg += "To install in Premiere Pro:\n";
    msg += "  1. Open Premiere Pro\n";
    msg += "  2. Essential Graphics panel > Browse tab\n";
    msg += "  3. Click hamburger menu > Install Motion Graphics Template\n";
    msg += "  4. Select the .mogrt files\n";
    msg += "\nOr copy .mogrt files to:\n";
    msg += "  macOS: ~/Library/Application Support/Adobe/Common/Essential Graphics/\n";
    msg += "  Windows: %APPDATA%/Adobe/Common/Essential Graphics/\n";

    alert(msg);

})();
