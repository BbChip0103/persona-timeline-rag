"""Acceptance assertions kept separate from the load generator."""


def verify(case, data):
    assert data, "missing evidence"
    if case in ("C1", "C2", "C3", "C6"):
        assert data["completed"] == data["total"]
        assert 0 < data["maximum"] <= 2
        assert data["duplicates"] == 0
        assert data["submitted"] == data["receipts"]
        if case in ("C1", "C6"):
            assert data["submitted"] > 0
            assert data["offloaded"] == data["submitted"]
            assert data["unknown"] == 0
        else:
            assert data["submitted"] == 0
            assert data["local_completed"] == data["total"]
            assert data["spillover_enabled"] is False
    elif case == "C4":
        assert data["killed"] and data["recovered_seconds"] <= data["deadline_seconds"] + 2.2
        assert data["recovered_seconds"] >= data["deadline_seconds"] + 1.8
        assert data["replayed"] == 1
    elif case == "C5":
        assert data["failed"] == data["unknown"] == data["submitted"] == 1
        assert data["duplicates"] == 0 and data["unaffected"] == 1
    else:
        raise AssertionError("unknown case")
