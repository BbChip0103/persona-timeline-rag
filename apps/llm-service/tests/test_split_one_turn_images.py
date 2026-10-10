"""A qualification run can use new images without retagging existing releases."""

import importlib.util
import inspect
from pathlib import Path


def test_selected_images_keep_existing_defaults():
    path = Path(__file__).resolve().parents[3] / "scripts" / "split-one-turn.py"
    spec = importlib.util.spec_from_file_location("split_one_turn_images", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    required = [
        "--roles-env",
        "/tmp/roles",
        "--serving-env",
        "/tmp/serving",
        "--output",
        "/tmp/out",
    ]
    default = module.parse_args(required)
    assert default.app_image == "ptr_app:split-final"
    assert default.llm_image == "ptr_llm:split-final"
    selected = module.parse_args(
        required + ["--app-image", "ptr_app:audit49", "--llm-image", "ptr_llm:audit49"]
    )
    assert selected.app_image == "ptr_app:audit49"
    assert selected.llm_image == "ptr_llm:audit49"
    parameters = inspect.signature(module.run).parameters
    assert parameters["app_image"].default == default.app_image
    assert parameters["llm_image"].default == default.llm_image
