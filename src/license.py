"""License validation via LemonSqueezy API."""
import hashlib
import json
import os
import platform
import time
import urllib.request
import urllib.error
import uuid

# Grace period: allow offline usage for 3 days
GRACE_PERIOD_DAYS = 3
GRACE_PERIOD_SECS = GRACE_PERIOD_DAYS * 86400

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
    """Generate a stable machine identifier."""
    parts = []
    parts.append(platform.node())
    parts.append(platform.machine())
    parts.append(platform.processor())
    try:
        # Use MAC address for additional uniqueness
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
        # Verify machine ID matches
        if data.get("machine_id") != _get_machine_id():
            return None
        return data
    except Exception:
        return None


def _clear_license():
    """Remove local license data."""
    path = _get_license_file()
    if os.path.isfile(path):
        os.remove(path)


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
        return {"error": str(e)}


def activate_license(license_key):
    """Activate a license key on this machine. Returns (success, message)."""
    machine_id = _get_machine_id()
    result = _api_call(ACTIVATE_URL, license_key, instance_name=machine_id)

    if result.get("valid") or result.get("activated"):
        instance_id = result.get("instance", {}).get("id", machine_id)
        _save_license(license_key, instance_id)
        return True, "License activated successfully."

    # Already activated on this machine
    if "already" in str(result.get("error", "")).lower():
        # Try to validate instead
        ok, msg = validate_license(license_key)
        if ok:
            return True, "License already active."
        return False, msg

    error = result.get("error", "Invalid license key.")
    return False, str(error)


def validate_license(license_key=None, instance_id=None):
    """Validate a license key. Returns (valid, message)."""
    if not license_key:
        data = _load_license()
        if not data:
            return False, "No license found."
        license_key = data.get("license_key")
        instance_id = data.get("instance_id")

    result = _api_call(VALIDATE_URL, license_key, instance_id=instance_id)

    if result.get("valid"):
        # Update last check time
        data = _load_license()
        if data:
            data["last_check"] = time.time()
            data["valid"] = True
            encoded = _obfuscate(json.dumps(data))
            with open(_get_license_file(), "w") as f:
                f.write(encoded)
        return True, "License valid."

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


def check_license():
    """
    Check if the app should be allowed to run.
    Returns (allowed, message).
    """
    data = _load_license()
    if not data:
        return False, "No license key entered."

    if not data.get("valid"):
        return False, "License is no longer valid."

    last_check = data.get("last_check", 0)
    elapsed = time.time() - last_check

    # If checked within last 24 hours, allow without re-check
    if elapsed < 86400:
        return True, "License valid."

    # Try to validate online
    ok, msg = validate_license()
    if ok:
        return True, msg

    # Offline grace period
    if elapsed < GRACE_PERIOD_SECS:
        remaining = int((GRACE_PERIOD_SECS - elapsed) / 86400)
        return True, f"Offline mode ({remaining} days remaining)."

    return False, "License check failed. Please connect to the internet."


def get_saved_key():
    """Get the saved license key, or None."""
    data = _load_license()
    if data:
        return data.get("license_key")
    return None
