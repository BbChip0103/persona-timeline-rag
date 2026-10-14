from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_kind_maintenance_secret_rebootstrap_forces_synthetic_dry_run_defaults() -> None:
    source = (ROOT / "deploy/kind/secrets.sh").read_text()
    patch = source[
        source.index("patch_existing_maintenance_secret()") : source.index(
            'if [ "$existing" -eq 0 ]'
        )
    ]

    for assignment in (
        '.data.PTR_MAINTENANCE_SYNTHETIC_ONLY = ("1" | @base64)',
        '.data.PTR_MAINTENANCE_APPLY = ("0" | @base64)',
        '.data.PTR_MAINTENANCE_TIMEOUT_SECONDS = ("300" | @base64)',
        '.data.PTR_MAINTENANCE_DAILY_LIMIT = ("100" | @base64)',
        '.data.PTR_MAINTENANCE_WEEKLY_SINCE_DAYS = ("7" | @base64)',
    ):
        assert assignment in patch

    fresh = source[source.index("name: ptr-maintenance") : source.index("name: ptr-personas")]
    for key, value in (
        ("PTR_MAINTENANCE_SYNTHETIC_ONLY", "1"),
        ("PTR_MAINTENANCE_APPLY", "0"),
        ("PTR_MAINTENANCE_TIMEOUT_SECONDS", "300"),
        ("PTR_MAINTENANCE_DAILY_LIMIT", "100"),
        ("PTR_MAINTENANCE_WEEKLY_SINCE_DAYS", "7"),
    ):
        assert f'{key}: "{value}"' in fresh
