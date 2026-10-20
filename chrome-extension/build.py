#!/usr/bin/env python3
"""Package the extension in src/ into dist/:

  netroute-extension-v<version>.zip   upload to the Chrome Web Store, or unzip + "Load unpacked"
  netroute-extension-v<version>.crx   signed CRX3 package (same as chrome://extensions → Pack extension)

The signing key lives in keys/netroute-extension.pem (created on first run, git-ignored).
Keep it: re-packing with the same key keeps the same extension ID so updates install over the old one.
Needs only Python 3 and the `openssl` command.
"""
import hashlib
import io
import json
import os
import struct
import subprocess
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "src")
DIST = os.path.join(HERE, "dist")
KEY = os.path.join(HERE, "keys", "netroute-extension.pem")


def openssl(*args, data=None):
    return subprocess.run(["openssl", *args], input=data, capture_output=True, check=True).stdout


def build_zip():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for root, dirs, files in os.walk(SRC):
            dirs.sort()
            for name in sorted(files):
                if name.startswith("."):
                    continue
                path = os.path.join(root, name)
                info = zipfile.ZipInfo(os.path.relpath(path, SRC), date_time=(2026, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                with open(path, "rb") as f:
                    z.writestr(info, f.read())
    return buf.getvalue()


# --- minimal protobuf encoding for the CRX3 header -----------------------------------------

def varint(n):
    out = bytearray()
    while True:
        b, n = n & 0x7F, n >> 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)


def field(num, payload):  # length-delimited field
    return varint(num << 3 | 2) + varint(len(payload)) + payload


def build_crx(zip_bytes):
    if not os.path.exists(KEY):
        os.makedirs(os.path.dirname(KEY), exist_ok=True)
        openssl("genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", KEY)
        os.chmod(KEY, 0o600)
        print(f"created signing key {os.path.relpath(KEY, HERE)} (keep it, never commit it)")
    pub = openssl("pkey", "-in", KEY, "-pubout", "-outform", "DER")
    crx_id = hashlib.sha256(pub).digest()[:16]
    signed_data = field(1, crx_id)                                    # SignedData.crx_id
    to_sign = b"CRX3 SignedData\x00" + struct.pack("<I", len(signed_data)) + signed_data + zip_bytes
    sig = openssl("dgst", "-sha256", "-sign", KEY, data=to_sign)
    header = field(2, field(1, pub) + field(2, sig)) + field(10000, signed_data)  # sha256_with_rsa, signed_header_data
    crx = b"Cr24" + struct.pack("<II", 3, len(header)) + header + zip_bytes
    ext_id = "".join(chr(ord("a") + int(c, 16)) for c in crx_id.hex())
    return crx, ext_id, pub, sig, to_sign


def verify(pub, sig, to_sign):
    tmp = os.path.join(DIST, ".verify")
    os.makedirs(tmp, exist_ok=True)
    pub_pem, sig_f = os.path.join(tmp, "pub.der"), os.path.join(tmp, "sig")
    with open(pub_pem, "wb") as f:
        f.write(pub)
    with open(sig_f, "wb") as f:
        f.write(sig)
    try:
        openssl("dgst", "-sha256", "-verify", pub_pem, "-keyform", "DER", "-signature", sig_f, data=to_sign)
    finally:
        for p in (pub_pem, sig_f):
            os.remove(p)
        os.rmdir(tmp)


def main():
    with open(os.path.join(SRC, "manifest.json")) as f:
        manifest = json.load(f)
    version = manifest["version"]
    os.makedirs(DIST, exist_ok=True)
    zip_bytes = build_zip()
    base = os.path.join(DIST, f"netroute-extension-v{version}")
    with open(base + ".zip", "wb") as f:
        f.write(zip_bytes)
    crx, ext_id, pub, sig, to_sign = build_crx(zip_bytes)
    verify(pub, sig, to_sign)
    with open(base + ".crx", "wb") as f:
        f.write(crx)
    print(f"{os.path.relpath(base, HERE)}.zip  ({len(zip_bytes) / 1024:.1f} KB)")
    print(f"{os.path.relpath(base, HERE)}.crx  ({len(crx) / 1024:.1f} KB, signature verified)")
    print(f"extension ID: {ext_id}")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as e:
        sys.exit(f"openssl failed: {e.stderr.decode().strip()}")
