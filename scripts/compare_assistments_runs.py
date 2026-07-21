from __future__ import annotations

import argparse
from pathlib import Path

from packages.evals.assistments.comparison import (
    compare_assistments_sessions,
    write_assistments_comparison_report,
)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Compare aligned ASSISTments memory-ablation sessions."
    )
    parser.add_argument("--none-session", required=True)
    parser.add_argument("--full-context-session", required=True)
    parser.add_argument("--notes-session", required=True)
    parser.add_argument("--chunk-size", type=int, required=True)
    parser.add_argument("--skipped-development-students", type=int, required=True)
    parser.add_argument("--maximum-student-interactions", type=int, required=True)
    parser.add_argument(
        "--root", type=Path, default=Path("state/evals/assistments")
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=Path("packages/evals/assistments/memory-arena-report.md"),
    )
    arguments = parser.parse_args()
    sessions = {
        "none": arguments.none_session,
        "full_context": arguments.full_context_session,
        "notes": arguments.notes_session,
    }
    comparison = compare_assistments_sessions(arguments.root, sessions)
    write_assistments_comparison_report(
        arguments.report,
        comparison,
        sessions=sessions,
        chunk_size=arguments.chunk_size,
        skipped_development_students=arguments.skipped_development_students,
        maximum_student_interactions=arguments.maximum_student_interactions,
    )
    print(f"ASSISTments memory comparison: {arguments.report}")


if __name__ == "__main__":
    main()
