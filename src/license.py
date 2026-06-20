"""License validation via LemonSqueezy API."""
import hashlib
import json
import os
import platform
import time
import urllib.request
import urllib.error
import uuid

# Grace period: allow offline usage for 1 day (24 hours).
# Only applies when the network is unreachable. If LemonSqueezy
# explicitly says the license is invalid, the app blocks immediately.
GRACE_PERIOD_SECS = 86400
TRIAL_MAX_EDITS = 3

ACTIVATE_URL = "https://api.lemonsqueezy.com/v1/licenses/activate"
VALIDATE_URL = "https://api.lemonsqueezy.com/v1/licenses/validate"
DEACTIVATE_URL = "https://api.lemonsqueezy.com/v1/licenses/deactivate"


def _get_license_file():
    """Get path to local license file."""
    if platform.system() == "Windows":
        base = os.environ.get("APPDATA", os.path.expanduser("~"))
    else:
        base = os.path.expanduser("~")
    license_dir = os.path.join(base, ".videoeditor")
    os.makedirs(license_dir, exist_ok=True)
    return os.path.join(license_dir, ".license")


def _get_machine_id():
    """Generate a stable machine identifier.

    Uses only values that are consistent across different Python builds
    (system Python, venv, Nuitka standalone). platform.processor() is
    intentionally excluded because it can return different values in
    Nuitka-compiled builds vs regular Python.
    """
    parts = []
    parts.append(platform.node())
    parts.append(platform.machine())
    try:
        mac = uuid.getnode()
        parts.append(str(mac))
    except Exception:
        pass
    raw = "|".join(parts)
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


def _obfuscate(data_str):
    """Simple obfuscation for local storage (not encryption, just deters casual editing)."""
    key = _get_machine_id()[:16].encode()
    data = data_str.encode()
    result = bytearray()
    for i, b in enumerate(data):
        result.append(b ^ key[i % len(key)])
    import base64
    return base64.b64encode(result).decode()


def _deobfuscate(encoded_str):
    """Reverse obfuscation."""
    import base64
    key = _get_machine_id()[:16].encode()
    data = base64.b64decode(encoded_str)
    result = bytearray()
    for i, b in enumerate(data):
        result.append(b ^ key[i % len(key)])
    return result.decode()


def _save_license(license_key, instance_id):
    """Save license data locally."""
    data = {
        "license_key": license_key,
        "instance_id": instance_id,
        "machine_id": _get_machine_id(),
        "last_check": time.time(),
        "valid": True,
    }
    path = _get_license_file()
    encoded = _obfuscate(json.dumps(data))
    with open(path, "w") as f:
        f.write(encoded)


def _load_license():
    """Load license data from local storage."""
    path = _get_license_file()
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r") as f:
            encoded = f.read().strip()
        data = json.loads(_deobfuscate(encoded))
        if data.get("machine_id") != _get_machine_id():
            # Machine ID changed (e.g. after rebuild). Re-save so future loads work.
            data["machine_id"] = _get_machine_id()
            _save_license(data["license_key"], data.get("instance_id", ""))
            return data
        return data
    except Exception:
        # Decoding failed — try legacy machine IDs (old builds included
        # platform.processor() which varies across Nuitka/system Python).
        try:
            with open(path, "r") as f:
                encoded = f.read().strip()
            data = _try_legacy_decode(encoded)
            if data:
                data["machine_id"] = _get_machine_id()
                _save_license(data["license_key"], data.get("instance_id", ""))
                return data
        except Exception:
            pass
        return None


def _try_legacy_decode(encoded_str):
    """Try to decode a license file written with old machine ID formats."""
    import base64
    raw_bytes = base64.b64decode(encoded_str)

    node = platform.node()
    mac_str = str(uuid.getnode())

    for proc in ['arm', '', 'arm64', 'i386', 'x86_64']:
        for machine in [platform.machine(), 'arm64', 'x86_64']:
            parts = [node, machine, proc, mac_str]
            raw = "|".join(parts)
            mid = hashlib.sha256(raw.encode()).hexdigest()[:32]
            key = mid[:16].encode()
            result = bytearray()
            for i, b in enumerate(raw_bytes):
                result.append(b ^ key[i % len(key)])
            try:
                decoded = result.decode('utf-8')
                data = json.loads(decoded)
                if "license_key" in data:
                    return data
            except Exception:
                continue
    return None


def _clear_license():
    """Remove local license data."""
    path = _get_license_file()
    if os.path.isfile(path):
        os.remove(path)


def _is_network_error(result):
    """Check if an API result represents a network error (vs explicit invalid)."""
    if not result:
        return True
    error = str(result.get("error", ""))
    # Network errors from urllib: timeout, connection refused, no route, DNS, etc.
    network_keywords = ["urlopen", "timeout", "connection", "network",
                        "unreachable", "refused", "gaierror", "nodename"]
    return any(kw in error.lower() for kw in network_keywords)


def _api_call(url, license_key, instance_name=None, instance_id=None):
    """Make API call to LemonSqueezy."""
    body = {"license_key": license_key}
    if instance_name:
        body["instance_name"] = instance_name
    if instance_id:
        body["instance_id"] = instance_id

    data = json.dumps(body).encode()
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode())
        except Exception:
            return {"valid": False, "error": str(e)}
    except Exception as e:
        # Network error — mark it so check_license can distinguish
        return {"error": str(e), "_network_error": True}


def activate_license(license_key):
    """Activate a license key on this machine. Returns (success, message)."""
    machine_id = _get_machine_id()
    result = _api_call(ACTIVATE_URL, license_key, instance_name=machine_id)

    if result.get("valid") or result.get("activated"):
        instance_id = result.get("instance", {}).get("id", machine_id)
        _save_license(license_key, instance_id)
        return True, "License activated successfully."

    # Already activated or activation limit reached — validate instead
    error_msg = str(result.get("error", "")).lower()
    if "already" in error_msg or "limit" in error_msg:
        ok, msg = validate_license(license_key)
        if ok:
            return True, "License already active."
        return False, msg

    error = result.get("error", "Invalid license key.")
    return False, str(error)


def validate_license(license_key=None, instance_id=None):
    """Validate a license key online. Returns (valid, message).

    Also returns a '_network_error' flag so callers can distinguish
    'no internet' from 'license explicitly invalid'.
    """
    if not license_key:
        data = _load_license()
        if not data:
            return False, "No license found."
        license_key = data.get("license_key")
        instance_id = data.get("instance_id")

    result = _api_call(VALIDATE_URL, license_key, instance_id=instance_id)

    if result.get("valid"):
        # Online check succeeded — update timestamp
        data = _load_license()
        if data:
            data["last_check"] = time.time()
            data["valid"] = True
            encoded = _obfuscate(json.dumps(data))
            with open(_get_license_file(), "w") as f:
                f.write(encoded)
        else:
            # First time (e.g. activation limit fallback) — save fresh
            _save_license(license_key, instance_id or "")
        return True, "License valid."

    # Check failed — distinguish network error from explicit invalid
    if result.get("_network_error") or _is_network_error(result):
        return False, "_network_error"

    # LemonSqueezy explicitly said invalid/expired — mark locally
    data = _load_license()
    if data:
        data["valid"] = False
        encoded = _obfuscate(json.dumps(data))
        with open(_get_license_file(), "w") as f:
            f.write(encoded)

    error = result.get("error", "License invalid or expired.")
    return False, str(error)


def deactivate_license():
    """Deactivate current license. Returns (success, message)."""
    data = _load_license()
    if not data:
        return False, "No license found."

    result = _api_call(
        DEACTIVATE_URL,
        data["license_key"],
        instance_id=data.get("instance_id"),
    )
    _clear_license()
    return True, "License deactivated."


def _get_trial_file():
    """Get path to the primary trial file."""
    if platform.system() == "Windows":
        base = os.environ.get("APPDATA", os.path.expanduser("~"))
    else:
        base = os.path.expanduser("~")
    trial_dir = os.path.join(base, ".videoeditor")
    os.makedirs(trial_dir, exist_ok=True)
    return os.path.join(trial_dir, ".trial")


def _get_trial_backup_file():
    """Secondary trial file in a different location. A casual bypass that
    deletes one file will be defeated because we take the MAX of both."""
    if platform.system() == "Windows":
        base = os.environ.get("LOCALAPPDATA", os.path.expanduser("~"))
        d = os.path.join(base, "SmartCut", "cache")
    elif platform.system() == "Darwin":
        d = os.path.expanduser("~/Library/Caches/com.smartcut.app")
    else:
        d = os.path.expanduser("~/.cache/smartcut")
    try:
        os.makedirs(d, exist_ok=True)
    except OSError:
        pass
    return os.path.join(d, ".tc")


def _read_one_trial(path):
    """Read + validate one trial file. Returns dict or None."""
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r") as f:
            encoded = f.read().strip()
        data = json.loads(_deobfuscate(encoded))
        # Prevent copying between machines
        if data.get("machine_id") != _get_machine_id():
            return None
        # Detect clock manipulation (current time before recorded first_use)
        if time.time() < data.get("first_use", 0) - 300:  # 5 min skew tolerance
            return None
        return data
    except Exception:
        return None


def _load_trial():
    """Load trial data — merge primary + backup, take the max of edits.
    This means deleting one file does NOT reset the trial counter."""
    primary = _read_one_trial(_get_trial_file())
    backup = _read_one_trial(_get_trial_backup_file())

    if primary is None and backup is None:
        return None

    if primary is None:
        return backup
    if backup is None:
        return primary

    # Both valid — merge with max(edits) and earliest first_use
    merged = dict(primary)
    merged["edits"] = max(primary.get("edits", 0), backup.get("edits", 0))
    merged["first_use"] = min(
        primary.get("first_use", time.time()),
        backup.get("first_use", time.time()),
    )
    return merged


def _save_trial(data):
    """Save trial data to BOTH locations (defense in depth against deletion)."""
    encoded = _obfuscate(json.dumps(data))
    for path in (_get_trial_file(), _get_trial_backup_file()):
        try:
            with open(path, "w") as f:
                f.write(encoded)
        except OSError:
            # Some sandboxed setups may block one location; ignore and keep
            # the other working.
            pass


def check_trial():
    """Check if trial usage is allowed. Returns (allowed, remaining, message)."""
    data = _load_trial()
    if data is None:
        data = {
            "edits": 0,
            "first_use": time.time(),
            "machine_id": _get_machine_id(),
        }
        _save_trial(data)

    edits = data.get("edits", 0)
    if edits >= TRIAL_MAX_EDITS:
        return False, 0, "Free trial ended."

    remaining = TRIAL_MAX_EDITS - edits
    return True, remaining, f"Trial: {remaining} edits remaining"


def increment_trial():
    """Increment trial edit count. Returns (remaining, total)."""
    data = _load_trial()
    if data is None:
        data = {
            "edits": 0,
            "first_use": time.time(),
            "machine_id": _get_machine_id(),
        }
    data["edits"] = data.get("edits", 0) + 1
    _save_trial(data)
    remaining = max(0, TRIAL_MAX_EDITS - data["edits"])
    return remaining, TRIAL_MAX_EDITS


def is_trial_mode():
    """Return True if no valid license exists and trial edits remain."""
    data = _load_license()
    if data and data.get("valid"):
        return False
    trial_ok, _, _ = check_trial()
    return trial_ok


def check_license():
    """
    Check if the app should be allowed to run.
    Returns (allowed, message).

    Logic:
    - If no license saved: block (show license screen)
    - If license marked invalid locally: block immediately
    - If last online check < 24h ago: allow without re-check
    - If last online check > 24h ago: try online validation
      - Online + valid: allow, update timestamp
      - Online + invalid: block immediately (no grace period)
      - Offline (network error): allow if last check < 1 day ago (grace period)
    """
    data = _load_license()
    if not data:
        trial_ok, remaining, trial_msg = check_trial()
        if trial_ok:
            return True, trial_msg
        return False, "Free trial ended. Enter a license key to continue."

    if not data.get("valid"):
        return False, "License is no longer valid."

    last_check = data.get("last_check", 0)
    elapsed = time.time() - last_check

    # Checked within last 24 hours — allow without re-check
    if elapsed < 86400:
        return True, "License valid."

    # More than 24 hours — must validate online
    ok, msg = validate_license()
    if ok:
        return True, msg

    # Validation failed — why?
    if msg == "_network_error":
        # No internet — grace period (1 day from last successful check)
        if elapsed < GRACE_PERIOD_SECS:
            return True, "Offline mode."
        return False, "License check failed. Please connect to the internet."

    # LemonSqueezy explicitly said invalid — block immediately, no grace
    return False, msg


def get_saved_key():
    """Get the saved license key, or None."""
    data = _load_license()
    if data:
        return data.get("license_key")
    return None
