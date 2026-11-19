import re
from datetime import datetime, timezone

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class ApiError(Exception):
    """Raised anywhere in a request; rendered as {"error": message, ...extra}."""

    def __init__(self, status, message, **extra):
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra


def utcnow():
    return datetime.now(timezone.utc)


def iso(dt=None):
    return (dt or utcnow()).strftime("%Y-%m-%dT%H:%M:%SZ")


def clean_text(value, label, max_len, required=True, multiline=False):
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise ApiError(422, f"{label} must be text.")
    value = _CTRL.sub("", value.replace("\r\n", "\n"))
    value = value.strip() if multiline else " ".join(value.split())
    if required and not value:
        raise ApiError(422, f"{label} is required.")
    if len(value) > max_len:
        raise ApiError(422, f"{label} must be {max_len} characters or fewer.")
    return value


def parse_int(value, label, lo, hi):
    try:
        if isinstance(value, bool):
            raise ValueError
        number = int(value)
    except (TypeError, ValueError):
        raise ApiError(422, f"{label} must be a whole number.")
    if not lo <= number <= hi:
        raise ApiError(422, f"{label} must be between {lo} and {hi}.")
    return number


def parse_bool(value, label="Value"):
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.lower() in ("true", "1", "yes", "on"):
        return True
    if isinstance(value, str) and value.lower() in ("false", "0", "no", "off"):
        return False
    raise ApiError(422, f"{label} must be true or false.")


def clean_email(value):
    email = (value or "").strip().lower() if isinstance(value, str) else ""
    if not EMAIL_RE.match(email) or len(email) > 254:
        raise ApiError(422, "Enter a valid email address.")
    return email
