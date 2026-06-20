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
    local nul = (package.config:sub(1,1) == "\\") and "2>NUL" or "2>/dev/null"
    local cmd = string.format('curl -s --max-time %d "%s" %s', timeout, url, nul)
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

local function get_license_status()
    local data = call_backend("/license-status", 3)
    if data == nil then return nil, "Backend unreachable" end
    return data.licensed == true, data.message or ""
end

-- Try to launch SmartCut.app so the backend starts. Best-effort; returns
-- nothing. The caller should re-poll /health after a short delay.
local function launch_smartcut_app()
    local sep = package.config:sub(1,1)
    if sep == "\\" then
        -- Windows: start the app via shell. The installed location varies;
        -- "start SmartCut" relies on it being on PATH, but try a few.
        os.execute('start "" "SmartCut.exe" 2>NUL')
        os.execute('start "" "C:\\Program Files\\SmartCut\\SmartCut.exe" 2>NUL')
    else
        -- macOS uses Launch Services to find the app by display name.
        os.execute('open -a "SmartCut" 2>/dev/null')
        -- Linux fallback
        os.execute('which smartcut >/dev/null 2>&1 && smartcut & 2>/dev/null')
    end
end

local function ensure_backend_ready()
    if check_backend() then return true end
    print("[SmartCut] Backend not reachable — launching SmartCut.app...")
    launch_smartcut_app()
    -- Poll for up to ~12 s while the app spins up its HTTP server
    for i = 1, 24 do
        os.execute(package.config:sub(1,1) == "\\" and "ping -n 1 127.0.0.1 >NUL" or "sleep 0.5")
        if check_backend() then
            print("[SmartCut] Backend up after auto-launch.")
            return true
        end
    end
    return false
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
        return fusion:AskUser("SmartCut", {
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

    -- Fallback: native OS dialog
    local is_win = (package.config:sub(1,1) == "\\")
    local items = {}
    local result

    if is_win then
        -- Windows: Write PowerShell script to temp file, execute it
        local tmp = os.getenv("TEMP") or "C:\\Temp"
        local ps_file = tmp .. "\\ve_style_picker.ps1"
        local result_file = tmp .. "\\ve_style_result.txt"

        -- Build style items for the script
        local ps_items = {}
        for _, s in ipairs(STYLES) do
            local desc = s.desc:gsub("[%(%)%[%]]", "")
            table.insert(ps_items, "    '" .. s.label .. " - " .. desc .. "'")
        end

        -- Write .ps1 file
        local f = io.open(ps_file, "w")
        if not f then
            print("[SmartCut] Cannot write style picker script")
            return STYLES[1] and STYLES[1].key or "clean"
        end
        f:write('Add-Type -AssemblyName System.Windows.Forms\n')
        f:write('Add-Type -AssemblyName System.Drawing\n')
        f:write('[System.Windows.Forms.Application]::EnableVisualStyles()\n')
        f:write('$form = New-Object System.Windows.Forms.Form\n')
        f:write('$form.Text = "SmartCut - Style"\n')
        f:write('$form.Size = New-Object System.Drawing.Size(420,200)\n')
        f:write('$form.StartPosition = "CenterScreen"\n')
        f:write('$form.TopMost = $true\n')
        f:write('$form.FormBorderStyle = "FixedDialog"\n')
        f:write('$form.MaximizeBox = $false\n')
        f:write('$label = New-Object System.Windows.Forms.Label\n')
        f:write('$label.Location = New-Object System.Drawing.Point(20,20)\n')
        f:write('$label.Size = New-Object System.Drawing.Size(360,20)\n')
        f:write('$label.Text = "Choose a style:"\n')
        f:write('$form.Controls.Add($label)\n')
        f:write('$combo = New-Object System.Windows.Forms.ComboBox\n')
        f:write('$combo.Location = New-Object System.Drawing.Point(20,50)\n')
        f:write('$combo.Size = New-Object System.Drawing.Size(360,30)\n')
        f:write('$combo.DropDownStyle = "DropDownList"\n')
        f:write('$items = @(\n')
        f:write(table.concat(ps_items, ",\n") .. '\n')
        f:write(')\n')
        f:write('foreach ($i in $items) { $combo.Items.Add($i) | Out-Null }\n')
        f:write('$combo.SelectedIndex = 0\n')
        f:write('$form.Controls.Add($combo)\n')
        f:write('$ok = New-Object System.Windows.Forms.Button\n')
        f:write('$ok.Location = New-Object System.Drawing.Point(200,110)\n')
        f:write('$ok.Size = New-Object System.Drawing.Size(80,30)\n')
        f:write('$ok.Text = "OK"\n')
        f:write('$ok.DialogResult = "OK"\n')
        f:write('$form.Controls.Add($ok)\n')
        f:write('$form.AcceptButton = $ok\n')
        f:write('$cancel = New-Object System.Windows.Forms.Button\n')
        f:write('$cancel.Location = New-Object System.Drawing.Point(300,110)\n')
        f:write('$cancel.Size = New-Object System.Drawing.Size(80,30)\n')
        f:write('$cancel.Text = "Cancel"\n')
        f:write('$cancel.DialogResult = "Cancel"\n')
        f:write('$form.Controls.Add($cancel)\n')
        f:write('$form.CancelButton = $cancel\n')
        f:write('$r = $form.ShowDialog()\n')
        f:write('$out = ""\n')
        f:write('if ($r -eq "OK") { $out = $combo.SelectedItem }\n')
        f:write('Set-Content -Path "' .. result_file:gsub("\\", "\\\\") .. '" -Value $out -NoNewline\n')
        f:close()

        -- Run the script and wait for it to finish
        -- Use io.popen (no visible console window) and poll for result file
        local done_file = tmp .. "\\ve_style_done.txt"
        -- Add done marker to end of PS script
        local df = io.open(ps_file, "a")
        if df then
            df:write('Set-Content -Path "' .. done_file:gsub("\\", "\\\\") .. '" -Value "done" -NoNewline\n')
            df:close()
        end
        io.popen('powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' .. ps_file .. '"')
        -- Wait for dialog to complete
        while true do
            local check = io.open(done_file, "r")
            if check then check:close(); break end
            sleep(0.2)
        end
        os.remove(done_file)

        -- Read result
        local rf = io.open(result_file, "r")
        if rf then
            result = rf:read("*a"):gsub("%s+$", "")
            rf:close()
            os.remove(result_file)
        else
            result = ""
        end
        os.remove(ps_file)

        if not result or result == "" then
            return nil  -- User cancelled
        end

        -- Match selection back to style key
        for _, s in ipairs(STYLES) do
            if result:find(s.label, 1, true) then
                return s.key
            end
        end
        return "clean"
    else
        -- macOS: AppleScript dialog
        for _, s in ipairs(STYLES) do
            table.insert(items, '"' .. s.label .. " — " .. s.desc .. '"')
        end
        local list_str = table.concat(items, ", ")
        local cmd = 'osascript -e \'choose from list {' .. list_str .. '} '
            .. 'with title "SmartCut" '
            .. 'with prompt "Choose a style:" '
            .. 'default items {"' .. STYLES[1].label .. " — " .. STYLES[1].desc .. '"}\' 2>/dev/null'

        local handle = io.popen(cmd)
        if not handle then return "clean" end
        result = handle:read("*a"):gsub("%s+$", "")
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
    -- The SmartCut backend (port 8456) renders the overlay so the user does
    -- not need a local Python interpreter or render script.
    local home = os.getenv("USERPROFILE") or os.getenv("HOME") or "/tmp"
    local sep = (package.config:sub(1,1) == "\\") and "\\" or "/"
    -- Hidden subfolder so overlay temp files don't pollute the user's videos
    -- list. SmartCut auto-cleans this folder of files older than 30 days at
    -- app startup.
    local overlay_dir = home .. sep .. "Movies" .. sep .. "Videos" .. sep .. ".smartcut_overlays"
    os.execute('mkdir -p "' .. overlay_dir .. '"')
    local overlay_path = overlay_dir .. sep .. "ve_subtitle_overlay_" .. os.time() .. ".mov"

    print("[SmartCut] Rendering subtitle overlay (" .. width .. "x" .. height .. ", " .. string.format("%.1f", duration_sec) .. "s)...")

    local path = "/render-srt-overlay"
        .. "?srt_path=" .. url_encode(srt_path)
        .. "&output_path=" .. url_encode(overlay_path)
        .. "&width=" .. width
        .. "&height=" .. height
        .. "&duration=" .. string.format("%.3f", duration_sec)
        .. "&fps=" .. fps

    local result = call_backend(path, 300)
    if not result or result.error then
        print("[SmartCut] Subtitle overlay failed: " .. ((result and result.error) or "no response"))
        return nil
    end
    print("[SmartCut] Subtitle overlay: " .. string.format("%.1f", result.size_mb or 0) .. " MB")
    return result.path or overlay_path
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
    local tl_name = "SmartCut - " .. clip_name .. " " .. os.date("%H%M%S")
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
        print("[SmartCut] Could not determine timeline duration — skipping subtitles")
        return true, tl_name, 0
    end

    local overlay_path = render_subtitle_overlay(srt_path, width, height, duration_sec, fps)
    if not overlay_path then return true, tl_name, 0 end

    -- Step 3: Import overlay into media pool
    print("[SmartCut] Importing overlay into media pool...")
    local overlay_items = media_pool:ImportMedia({overlay_path})
    if not overlay_items or #overlay_items == 0 then
        print("[SmartCut] Failed to import overlay into media pool")
        return true, tl_name, 0
    end

    -- Step 4: Add V2 track and place overlay
    local video_track_count = new_tl:GetTrackCount("video")
    if video_track_count < 2 then
        new_tl:AddTrack("video")
    end

    print("[SmartCut] Placing subtitles on V2...")
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
        -- Set composite mode to "Screen" so black background becomes transparent
        local composite_set = false

        -- Try on the returned timeline item
        pcall(function()
            result[1]:SetProperty("CompositeMode", 5)  -- 6 = Screen
            composite_set = true
        end)

        -- Try string variant
        if not composite_set then
            pcall(function()
                result[1]:SetProperty("CompositeMode", "Screen")
                composite_set = true
            end)
        end

        -- Try via GetItemListInTrack
        if not composite_set then
            pcall(function()
                local clips_v2 = new_tl:GetItemListInTrack("video", 2)
                if clips_v2 and #clips_v2 > 0 then
                    local item = clips_v2[#clips_v2]
                    item:SetProperty("CompositeMode", 5)
                    composite_set = true
                end
            end)
        end

        if not composite_set then
            pcall(function()
                local clips_v2 = new_tl:GetItemListInTrack("video", 2)
                if clips_v2 and #clips_v2 > 0 then
                    clips_v2[#clips_v2]:SetProperty("CompositeMode", "Screen")
                    composite_set = true
                end
            end)
        end

        if composite_set then
            print("[SmartCut] Subtitles on V2 (Screen composite)")
        else
            print("[SmartCut] WARNING: Could not set Screen composite mode automatically.")
            print("[SmartCut] Please set it manually: Right-click V2 clip > Inspector > Composite > Screen")
        end
        sub_count = 1
    else
        print("[SmartCut] Could not place subtitles on V2")
    end

    return true, tl_name, sub_count
end


-- ============================================================================
-- Main
-- ============================================================================

print("")
print("========================================")
print("  SMARTCUT - DaVinci Resolve")
print("========================================")
print("")

-- 1. Check backend (and try to auto-launch SmartCut.app if needed)
print("[SmartCut] Checking backend...")
if not ensure_backend_ready() then
    print("[SmartCut] ERROR: Could not reach SmartCut backend.")
    print("[SmartCut] Please open SmartCut.app manually, then run again.")
    return
end
print("[SmartCut] Backend connected.")

-- License gate — backend is reachable but check whether it's actually
-- licensed. Without a valid license the /analyze endpoint will 403; show
-- a friendly message instead of letting it fail later.
local licensed, lic_msg = get_license_status()
if licensed == false then
    print("[SmartCut] License inactive: " .. tostring(lic_msg))
    print("[SmartCut] Opening SmartCut.app so you can re-activate...")
    launch_smartcut_app()
    return
end

-- 2. Detect clip on timeline
local clip_path = get_current_clip_path()
if not clip_path then
    print("[SmartCut] ERROR: No clip on timeline V1.")
    print("[SmartCut] Add a video clip to the timeline first.")
    return
end
local clip_name = clip_path:match("([^/]+)%.[^%.]+$") or "clip"
print("[SmartCut] Clip: " .. clip_name)

-- 3. Show style picker
local style = show_settings_dialog()
if not style then
    print("[SmartCut] Cancelled.")
    return
end
print("[SmartCut] Style: " .. style)

-- 3b. Probe orientation so the SmartCam picker can omit Landscape for
-- portrait input (avoids letterboxing in 16:9 output).
local probe = call_backend("/probe-orientation?video_path=" .. url_encode(clip_path), 8)
local input_orient = (probe and probe.orientation) or "landscape"
print("[SmartCut] Input orientation: " .. input_orient)

-- 3c. SmartCam picker (Fusion AskUser only — falls silently to Off if
-- AskUser is unavailable, e.g. on Resolve free without Fusion module).
local smartcam_enabled = false
local smartcam_format = "portrait"
do
    local sc_options
    if input_orient == "portrait" then
        sc_options = {
            "Off — keep video as-is",
            "Portrait 9:16 — Speaker Focus zoom",
        }
    else
        sc_options = {
            "Off — keep video as-is",
            "Portrait 9:16 — reframe for TikTok/Reels",
            "Landscape 16:9 — Speaker Focus zoom",
        }
    end
    local sc_ok, sc_ret = pcall(function()
        return fusion:AskUser("SmartCut — SmartCam", {
            {"SmartCam", Name = "SmartCam", "Dropdown",
             Options = sc_options, Default = 0},
        })
    end)
    if sc_ok and sc_ret then
        local sc_idx = (sc_ret.SmartCam or 0) + 1
        if sc_idx == 2 then
            smartcam_enabled = true
            smartcam_format = "portrait"
        elseif sc_idx == 3 then
            smartcam_enabled = true
            smartcam_format = "landscape"
        end
    elseif sc_ok and not sc_ret then
        print("[SmartCut] Cancelled at SmartCam picker.")
        return
    end
    -- pcall failed (no Fusion AskUser available) → keep defaults (Off)
end
if smartcam_enabled then
    print("[SmartCut] SmartCam: " .. smartcam_format)
else
    print("[SmartCut] SmartCam: off")
end

-- 4. Start analysis
print("[SmartCut] Starting analysis...")
local url = "/analyze?video_path=" .. url_encode(clip_path)
    .. "&style=" .. url_encode(style)
    .. "&whisper_model=medium"
    .. "&smartcam_enabled=" .. (smartcam_enabled and "1" or "0")
    .. "&smartcam_format=" .. url_encode(smartcam_format)
    .. "&resolution=1080"
local data = call_backend(url, 15)

if not data then
    print("[SmartCut] ERROR: Could not reach backend.")
    return
end
if data.error then
    print("[SmartCut] ERROR: " .. tostring(data.error))
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
            print(string.format("[SmartCut] [%d%%] %s", pct, msg))
            last_msg = msg
        end

        if st.status == "done" then
            local cuts = st.segments_count or 0

            -- 6. Export XML + SRT
            -- match_filenames=true: put the actual on-disk filename in <name>
            --   (DaVinci's strict clip lookup matches names exactly).
            -- skip_normalize=true: bypass the rotation pre-bake step. DaVinci
            --   handles rotation itself and chokes on the large high-bitrate
            --   H.264 produced by ultrafast x264, so we point straight at the
            --   original source instead.
            print("[SmartCut] Creating edited timeline...")
            local xml_data = call_backend("/export-xml?match_filenames=true&skip_normalize=true", 30)

            if not xml_data or xml_data.error then
                print("[SmartCut] ERROR: " .. ((xml_data and xml_data.error) or "Export failed"))
                return
            end

            -- 7. Import into Resolve
            local ok, tl_name, sub_count = import_into_resolve(
                xml_data.xml_path or "", xml_data.srt_path,
                clip_name, style)

            -- Note: Do NOT delete overlay files — Resolve references them on disk

            if ok then
                local style_labels = {clean="Clean", fast="Fast", balanced="Balanced", smooth="Smooth", minimal="Minimal"}
                local label = style_labels[style] or style
                local msg = "Done! " .. cuts .. " cuts"
                if sub_count > 0 then msg = msg .. " + " .. sub_count .. " subtitles" end
                msg = msg .. " (" .. label .. ")"
                print("")
                print("[SmartCut] " .. msg)
                print("[SmartCut] Timeline: " .. tostring(tl_name))
                print("")
            else
                print("[SmartCut] ERROR: " .. tostring(tl_name))
            end
            return

        elseif st.status == "error" then
            print("[SmartCut] ERROR: " .. (st.error or "Analysis failed"))
            return
        end
    end
end
