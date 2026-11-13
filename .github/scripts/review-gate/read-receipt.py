"""Read one bounded JSON receipt from stdin ZIP data; never extract entries."""
import io
import json
import stat
import sys
import zipfile


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def reject_constant(value):
    raise ValueError("Non-finite JSON number")


def read_receipt(data):
    if len(data) > 131072:
        raise ValueError("Oversized receipt archive")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        if len(entries) != 1:
            raise ValueError("Receipt must contain exactly one JSON entry")
        entry = entries[0]
        mode = entry.external_attr >> 16
        if (entry.filename != "receipt.json" or entry.is_dir()
                or entry.file_size > 65536 or entry.flag_bits & 1
                or (stat.S_IFMT(mode) not in (0, stat.S_IFREG))):
            raise ValueError("Unsafe receipt entry")
        with archive.open(entry) as stream:
            raw = stream.read(65537)
        if len(raw) > 65536:
            raise ValueError("Oversized receipt JSON")
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object,
                           parse_constant=reject_constant)
        if not isinstance(value, dict):
            raise ValueError("Expected receipt object")
        return value


if __name__ == "__main__":
    print(json.dumps(read_receipt(sys.stdin.buffer.read(131073)),
                     separators=(",", ":"), ensure_ascii=True))
