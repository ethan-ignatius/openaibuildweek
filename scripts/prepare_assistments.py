from __future__ import annotations

import argparse
from pathlib import Path

from packages.evals.assistments.data import write_verified_manifest


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Record provenance for an authorized corrected ASSISTments file."
    )
    parser.add_argument("source", type=Path)
    parser.add_argument(
        "--manifest",
        type=Path,
        default=Path("data/assistments/manifest.json"),
    )
    parser.add_argument(
        "--confirm-corrected-deduplicated",
        action="store_true",
        help="Required acknowledgement that this is not the original duplicated release.",
    )
    arguments = parser.parse_args()
    if not arguments.confirm_corrected_deduplicated:
        parser.error("--confirm-corrected-deduplicated is required")

    manifest = write_verified_manifest(arguments.source, arguments.manifest)
    print(f"Wrote {arguments.manifest}")
    print(f"SHA-256: {manifest['sha256']}")


if __name__ == "__main__":
    main()
