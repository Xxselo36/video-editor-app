--[[
Video Editor - DaVinci Resolve Plugin

Integrates the Video Editor's transcription and silence detection
directly into DaVinci Resolve. Works with both Free and Studio.

Architecture:
    This script (Lua)  <-->  HTTP (curl)  <-->  backend (port 8456)

Installation:
    Copy this file to:
      macOS:   /Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Edit/
    Start the Video Editor app (backend starts automatically on port 8456).
    In Resolve:  Workspace -> Scripts -> Edit -> video_editor_resolve
]]

-- ============================================================================
-- Minimal JSON decoder
-- ============================================================================

local function json_decode(str)
    local pos = 1

    local function skip_ws()
        pos = str:find("[^ \t\r\n]", pos) or (#str + 1)
    end

    local function parse_string()
        pos = pos + 1
        local result = {}
        while pos <= #str do
            local c = str:sub(pos, pos)
            if c == '"' then
                pos = pos + 1
                return table.concat(result)
            elseif c == '\\' then
                pos = pos + 1
                local esc = str:sub(pos, pos)
                if esc == 'n' then table.insert(result, '\n')
                elseif esc == 't' then table.insert(result, '\t')
                elseif esc == 'r' then table.insert(result, '\r')
                elseif esc == '\\' then table.insert(result, '\\')
                elseif esc == '"' then table.insert(result, '"')
                elseif esc == '/' then table.insert(result, '/')
                else table.insert(result, esc) end
                pos = pos + 1
            else
                table.insert(result, c)
                pos = pos + 1
            end
        end
        return table.concat(result)
    end

    local parse_value

    local function parse_object()
        pos = pos + 1
        local obj = {}
        skip_ws()
        if str:sub(pos, pos) == '}' then pos = pos + 1; return obj end
        while pos <= #str do
            skip_ws()
            local key = parse_string()
            skip_ws()
            pos = pos + 1
            skip_ws()
            obj[key] = parse_value()
            skip_ws()
            local c = str:sub(pos, pos)
            if c == '}' then pos = pos + 1; return obj end
            pos = pos + 1
        end
        return obj
    end

    local function parse_array()
        pos = pos + 1
        local arr = {}
        skip_ws()
        if str:sub(pos, pos) == ']' then pos = pos + 1; return arr end
        while pos <= #str do
            skip_ws()
            table.insert(arr, parse_value())
            skip_ws()
            local c = str:sub(pos, pos)
            if c == ']' then pos = pos + 1; return arr end
            pos = pos + 1
        end
        return arr
    end

    local function parse_number()
        local start = pos
        if str:sub(pos, pos) == '-' then pos = pos + 1 end
        while pos <= #str and str:sub(pos, pos):match("[%d%.eE%+%-]") do
            pos = pos + 1
        end
        return tonumber(str:sub(start, pos - 1))
    end

    parse_value = function()
        skip_ws()
        local c = str:sub(pos, pos)
        if c == '"' then return parse_string()
        elseif c == '{' then return parse_object()
        elseif c == '[' then return parse_array()
        elseif c == 't' then pos = pos + 4; return true
        elseif c == 'f' then pos = pos + 5; return false
        elseif c == 'n' then pos = pos + 4; return nil
        else return parse_number()
        end
    end

    return parse_value()
end


-- ============================================================================
-- Sleep helper (works without bmd/Studio)
-- ============================================================================

local function sleep(seconds)
    local ok = pcall(function() bmd.wait(seconds) end)
    if not ok then
        os.execute("sleep " .. tostring(seconds))
    end
end


-- ============================================================================
-- HTTP helpers (curl)
-- ============================================================================

local API_URL = "http://127.0.0.1:8456"

local function call_backend(path, timeout)
    timeout = timeout or 10
    local url = API_URL .. path
    local cmd = string.format('curl -s --max-time %d "%s" 2>/dev/null', timeout, url)
    local handle = io.popen(cmd)
    if not handle then return nil end
    local result = handle:read("*a")
    handle:close()
    if not result or result == "" then return nil end
    local ok, data = pcall(json_decode, result)
    if ok then return data end
    return nil
end

local function check_backend()
    local data = call_backend("/health", 3)
    return data ~= nil and data.status == "ok"
end

local function url_encode(str)
    return str:gsub("([^%w%-%.%_%~])", function(c)
        return string.format("%%%02X", string.byte(c))
    end)
end


-- ============================================================================
-- SRT parser
-- ============================================================================

local function parse_srt(srt_path)
    if not srt_path or srt_path == "" then return {} end
    local f = io.open(srt_path, "r")
    if not f then return {} end
    local content = f:read("*a")
    f:close()
    content = content .. "\n\n"

    local entries = {}
    for sh,sm,ss,sms, eh,em,es,ems, text in content:gmatch(
        "(%d+):(%d+):(%d+)[,.](%d+)%s*%-%->%s*(%d+):(%d+):(%d+)[,.](%d+)%s*\n(.-)\n%s*\n") do
        local start_s = tonumber(sh)*3600 + tonumber(sm)*60 + tonumber(ss) + tonumber(sms)/1000
        local end_s = tonumber(eh)*3600 + tonumber(em)*60 + tonumber(es) + tonumber(ems)/1000
        text = text:gsub("%s+$", ""):gsub("\n", " ")
        if text ~= "" then
            table.insert(entries, {start=start_s, ["end"]=end_s, text=text})
        end
    end
    return entries
end


-- ============================================================================
-- Styles (same as Premiere plugin)
-- ============================================================================

local STYLES = {
    {key="clean",    label="Clean",    desc="Tight cuts, phrase subtitles (4 words accumulating)"},
    {key="fast",     label="Fast",     desc="Fast cuts, word-by-word subtitles"},
    {key="balanced", label="Balanced", desc="Balanced cuts, word-by-word subtitles"},
    {key="smooth",   label="Smooth",   desc="Smooth cuts, word-by-word subtitles"},
    {key="minimal",  label="Minimal",  desc="Tight cuts, no subtitles"},
}


-- ============================================================================
-- Settings dialog
-- ============================================================================

local function show_settings_dialog()
    -- Try fusion:AskUser first (Studio)
    local style_options = {}
    for _, s in ipairs(STYLES) do
        table.insert(style_options, s.label .. " — " .. s.desc)
    end

    local dlg_ok, ret = pcall(function()
        return fusion:AskUser("Video Editor", {
            {"Style", Name = "Style", "Dropdown", Options = style_options, Default = 0},
        })
    end)

    if dlg_ok and ret then
        local idx = (ret.Style or 0) + 1
        return STYLES[idx] and STYLES[idx].key or "clean"
    end
    if dlg_ok and not ret then
        return nil  -- User cancelled
    end

    -- Fallback: native macOS dialog via AppleScript
    local items = {}
    for _, s in ipairs(STYLES) do
        table.insert(items, '"' .. s.label .. " — " .. s.desc .. '"')
    end
    local list_str = table.concat(items, ", ")
    local cmd = 'osascript -e \'choose from list {' .. list_str .. '} '
        .. 'with title "Video Editor" '
        .. 'with prompt "Choose a style:" '
        .. 'default items {"' .. STYLES[1].label .. " — " .. STYLES[1].desc .. '"}\' 2>/dev/null'

    local handle = io.popen(cmd)
    if not handle then return "clean" end
    local result = handle:read("*a"):gsub("%s+$", "")
    handle:close()

    if not result or result == "" or result == "false" then
        return nil  -- User cancelled
    end

    -- Match selection back to style key
    for _, s in ipairs(STYLES) do
        if result:find(s.label, 1, true) then
            return s.key
        end
    end
    return "clean"
end


-- ============================================================================
-- Resolve helpers
-- ============================================================================

local function get_current_clip_path()
    local ok, result = pcall(function()
        local project = resolve:GetProjectManager():GetCurrentProject()
        if not project then return nil end
        local timeline = project:GetCurrentTimeline()
        if not timeline then return nil end

        -- Try selected/current clip first
        local item = timeline:GetCurrentVideoItem()
        if item then
            local mpi = item:GetMediaPoolItem()
            if mpi then
                local props = mpi:GetClipProperty()
                if props and props["File Path"] and props["File Path"] ~= "" then
                    return props["File Path"]
                end
            end
        end

        -- Fallback: first clip on V1
        local clips = timeline:GetItemListInTrack("video", 1)
        if not clips or #clips == 0 then return nil end
        local mpi = clips[1]:GetMediaPoolItem()
        if not mpi then return nil end
        local props = mpi:GetClipProperty()
        if props and props["File Path"] and props["File Path"] ~= "" then
            return props["File Path"]
        end
        return nil
    end)
    if ok then return result end
    return nil
end

-- ============================================================================
-- Render subtitle overlay (transparent ProRes 4444 video)
-- ============================================================================

local function render_subtitle_overlay(srt_path, width, height, duration_sec, fps)
    -- Find Python (try venv, then system)
    local python = nil
    local try_pythons = {
        os.getenv("HOME") .. "/video-editor-app/venv313/bin/python3",
        "/usr/local/bin/python3",
        "/opt/homebrew/bin/python3",
        "python3",
    }
    for _, p in ipairs(try_pythons) do
        local test = io.popen(p .. ' -c "print(1)" 2>/dev/null')
        if test then
            local out = test:read("*a"):gsub("%s+", "")
            test:close()
            if out == "1" then python = p; break end
        end
    end
    if not python then
        print("[Video Editor] Python not found — skipping subtitles")
        return nil
    end

    -- Find render script
    local script_paths = {
        "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Edit/render_srt_overlay.py",
        os.getenv("HOME") .. "/video-editor-app/plugins/davinci/render_srt_overlay.py",
    }
    local render_script = nil
    for _, sp in ipairs(script_paths) do
        local tf = io.open(sp, "r")
        if tf then tf:close(); render_script = sp; break end
    end
    if not render_script then
        print("[Video Editor] render_srt_overlay.py not found — skipping subtitles")
        return nil
    end

    local overlay_path = "/tmp/ve_subtitle_overlay_" .. os.time() .. ".mov"
    print("[Video Editor] Rendering subtitle overlay (" .. width .. "x" .. height .. ", " .. string.format("%.1f", duration_sec) .. "s)...")
    local cmd = string.format('%s "%s" "%s" "%s" %d %d %.3f %d 2>&1',
        python, render_script, srt_path, overlay_path, width, height, duration_sec, fps)
    local handle = io.popen(cmd)
    if not handle then return nil end
    local json_out = handle:read("*a")
    handle:close()

    local ok, result = pcall(json_decode, json_out)
    if not ok or not result or result.error then
        print("[Video Editor] Subtitle overlay failed: " .. (result and result.error or json_out:sub(1, 200)))
        return nil
    end
    print("[Video Editor] Subtitle overlay: " .. string.format("%.1f", result.size_mb or 0) .. " MB")
    return overlay_path
end


-- ============================================================================
-- Import into Resolve: XML for cuts, then subtitle overlay on V2 via API
-- ============================================================================

local function import_into_resolve(xml_path, srt_path, clip_name, style_name)
    local project = resolve:GetProjectManager():GetCurrentProject()
    if not project then return false, "No project open", 0 end

    local media_pool = project:GetMediaPool()
    local root = media_pool:GetRootFolder()

    -- Create subfolder in Media Pool
    local folder = media_pool:AddSubFolder(root, clip_name .. " - " .. style_name)
    if folder then
        media_pool:SetCurrentFolder(folder)
    else
        media_pool:SetCurrentFolder(root)
    end

    -- Step 1: Import XML as timeline (V1 cuts)
    local tl_name = "Video Editor - " .. clip_name .. " " .. os.date("%H%M%S")
    local new_tl = media_pool:ImportTimelineFromFile(xml_path, {
        timelineName = tl_name,
        importSourceClips = true,
    })

    if not new_tl then return false, "ImportTimelineFromFile failed", 0 end
    project:SetCurrentTimeline(new_tl)

    -- Step 2: Render subtitle overlay (skip for "minimal" style)
    if style_name == "minimal" or not srt_path or srt_path == "" then
        return true, tl_name, 0
    end

    local fps = tonumber(new_tl:GetSetting("timelineFrameRate")) or 30
    local width = tonumber(new_tl:GetSetting("timelineResolutionWidth")) or 1920
    local height = tonumber(new_tl:GetSetting("timelineResolutionHeight")) or 1080
    local start_frame = new_tl:GetStartFrame() or 0
    local end_frame = new_tl:GetEndFrame() or 0
    local duration_frames = end_frame - start_frame
    local duration_sec = duration_frames / fps

    if duration_sec <= 0 then
        print("[Video Editor] Could not determine timeline duration — skipping subtitles")
        return true, tl_name, 0
    end

    local overlay_path = render_subtitle_overlay(srt_path, width, height, duration_sec, fps)
    if not overlay_path then return true, tl_name, 0 end

    -- Step 3: Import overlay into media pool
    print("[Video Editor] Importing overlay into media pool...")
    local overlay_items = media_pool:ImportMedia({overlay_path})
    if not overlay_items or #overlay_items == 0 then
        print("[Video Editor] Failed to import overlay into media pool")
        return true, tl_name, 0
    end

    -- Step 4: Add V2 track and place overlay
    local video_track_count = new_tl:GetTrackCount("video")
    if video_track_count < 2 then
        new_tl:AddTrack("video")
    end

    print("[Video Editor] Placing subtitles on V2...")
    local result = media_pool:AppendToTimeline({{
        mediaPoolItem = overlay_items[1],
        startFrame = 0,
        endFrame = duration_frames,
        mediaType = 1,
        trackIndex = 2,
        recordFrame = start_frame,
    }})

    local sub_count = 0
    if result and #result > 0 then
        sub_count = 1
        print("[Video Editor] Subtitles placed on V2")
    else
        print("[Video Editor] Could not place subtitles on V2")
    end

    return true, tl_name, sub_count
end


-- ============================================================================
-- Main
-- ============================================================================

print("")
print("========================================")
print("  VIDEO EDITOR - DaVinci Resolve")
print("========================================")
print("")

-- 1. Check backend
print("[Video Editor] Checking backend...")
if not check_backend() then
    print("[Video Editor] ERROR: Backend not running!")
    print("[Video Editor] Start the Video Editor app first.")
    return
end
print("[Video Editor] Backend connected.")

-- 2. Detect clip on timeline
local clip_path = get_current_clip_path()
if not clip_path then
    print("[Video Editor] ERROR: No clip on timeline V1.")
    print("[Video Editor] Add a video clip to the timeline first.")
    return
end
local clip_name = clip_path:match("([^/]+)%.[^%.]+$") or "clip"
print("[Video Editor] Clip: " .. clip_name)

-- 3. Show style picker
local style = show_settings_dialog()
if not style then
    print("[Video Editor] Cancelled.")
    return
end
print("[Video Editor] Style: " .. style)

-- 4. Start analysis
print("[Video Editor] Starting analysis...")
local url = "/analyze?video_path=" .. url_encode(clip_path)
    .. "&style=" .. url_encode(style)
    .. "&whisper_model=medium"
local data = call_backend(url, 15)

if not data then
    print("[Video Editor] ERROR: Could not reach backend.")
    return
end
if data.error then
    print("[Video Editor] ERROR: " .. tostring(data.error))
    return
end

-- 5. Poll job status
local last_msg = ""
while true do
    sleep(2)
    local st = call_backend("/job-status", 5)

    if st then
        local pct = st.progress or 0
        local msg = st.message or ""

        if msg ~= "" and msg ~= last_msg then
            print(string.format("[Video Editor] [%d%%] %s", pct, msg))
            last_msg = msg
        end

        if st.status == "done" then
            local cuts = st.segments_count or 0

            -- 6. Export XML + SRT
            print("[Video Editor] Creating edited timeline...")
            local xml_data = call_backend("/export-xml", 30)

            if not xml_data or xml_data.error then
                print("[Video Editor] ERROR: " .. ((xml_data and xml_data.error) or "Export failed"))
                return
            end

            -- 7. Import into Resolve
            local ok, tl_name, sub_count = import_into_resolve(
                xml_data.xml_path or "", xml_data.srt_path,
                clip_name, style)

            if ok then
                local style_labels = {clean="Clean", fast="Fast", balanced="Balanced", smooth="Smooth", minimal="Minimal"}
                local label = style_labels[style] or style
                local msg = "Done! " .. cuts .. " cuts"
                if sub_count > 0 then msg = msg .. " + " .. sub_count .. " subtitles" end
                msg = msg .. " (" .. label .. ")"
                print("")
                print("[Video Editor] " .. msg)
                print("[Video Editor] Timeline: " .. tostring(tl_name))
                print("")
            else
                print("[Video Editor] ERROR: " .. tostring(tl_name))
            end
            return

        elseif st.status == "error" then
            print("[Video Editor] ERROR: " .. (st.error or "Analysis failed"))
            return
        end
    end
end
