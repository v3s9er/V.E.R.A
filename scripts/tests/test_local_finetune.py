"""Synthetic, dependency-free tests; never train or read user conversations."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import subprocess
import sys
from unittest.mock import patch

MODULE_PATH = Path(__file__).resolve().parents[1] / "local-finetune.py"
SPEC = importlib.util.spec_from_file_location("mr_robot_local_finetune", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def example(question):
    return {"messages": [{"role": "user", "content": question}, {"role": "assistant", "content": "Synthetic answer."}]}


def exported(directory, train=None, evaluation=None):
    train = train or [example("Training question?")]
    evaluation = evaluation or [example("Held-out question?")]
    raw = lambda rows: ("\n".join(json.dumps(row) for row in rows) + "\n").encode()
    train_raw, eval_raw = raw(train), raw(evaluation)
    (directory / "train.jsonl").write_bytes(train_raw)
    (directory / "eval.jsonl").write_bytes(eval_raw)
    manifest = {"version": 1, "kind": "mr-robot-local-sft", "privacyReviewed": True, "network": "disabled",
                "trainSha256": hashlib.sha256(train_raw).hexdigest(), "evalSha256": hashlib.sha256(eval_raw).hexdigest(),
                "dataset": {"id": "synthetic-test", "seed": "fixture", "counts": {"trainRows": len(train), "evalRows": len(evaluation)}}}
    (directory / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")


class LocalFineTuningTests(unittest.TestCase):
    def test_actual_cli_synthetic_dry_run_without_weights_or_network(self):
        with tempfile.TemporaryDirectory(prefix="mrrobot-finetuning-cli-test-") as directory:
            path = Path(directory)
            exported(path)
            files_before = sorted(path.iterdir())
            result = subprocess.run([sys.executable, str(MODULE_PATH), "--dataset-dir", directory], shell=False, capture_output=True, text=True, encoding="utf-8", timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(result.stdout)
            self.assertEqual(report["trainRows"], 1)
            self.assertEqual(report["evalRows"], 1)
            self.assertFalse(report["trainingStarted"])
            self.assertIsNone(report["model"])
            self.assertEqual(report["network"], "disabled")
            self.assertEqual(sorted(path.iterdir()), files_before)

    def test_dry_run_without_ml_dependencies_or_model_has_no_side_effects(self):
        with tempfile.TemporaryDirectory(prefix="mrrobot-finetuning-test-") as directory:
            path = Path(directory)
            exported(path)
            files_before = sorted(path.iterdir())
            args = MODULE.parser().parse_args(["--dataset-dir", directory])
            with patch.object(MODULE, "dependency_report", return_value={name: None for name in MODULE.DEPENDENCIES}), patch.object(MODULE, "hardware_report", return_value={"checked": False}):
                report = MODULE.run(args)
            self.assertEqual(report["mode"], "dry-run")
            self.assertFalse(report["trainingStarted"])
            self.assertEqual(report["network"], "disabled")
            self.assertEqual(sorted(path.iterdir()), files_before)

    def test_checksums_privacy_schema_and_credential_checks_fail_closed(self):
        with tempfile.TemporaryDirectory(prefix="mrrobot-finetuning-test-") as directory:
            path = Path(directory)
            exported(path)
            (path / "train.jsonl").write_text("changed", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "checksum"):
                MODULE.load_export(path)
            exported(path, train=[example("api" + "_key=" + "synthetic" * 4)])
            with self.assertRaisesRegex(ValueError, "credential"):
                MODULE.load_export(path)
            exported(path)
            manifest = json.loads((path / "manifest.json").read_text())
            manifest["privacyReviewed"] = False
            (path / "manifest.json").write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, "reviewed"):
                MODULE.load_export(path)
            with self.assertRaisesRegex(ValueError, "schema"):
                MODULE.read_rows(b'{"text":"not chat"}')

    def test_train_requires_explicit_confirmation_and_never_installs_dependencies(self):
        with tempfile.TemporaryDirectory(prefix="mrrobot-finetuning-test-") as directory:
            exported(Path(directory))
            args = MODULE.parser().parse_args(["--dataset-dir", directory, "--train"])
            with patch.object(MODULE, "dependency_report", return_value={name: None for name in MODULE.DEPENDENCIES}), patch.object(MODULE, "hardware_report", return_value={"checked": False}):
                with self.assertRaisesRegex(ValueError, "confirm-local-training"):
                    MODULE.run(args)

    def test_train_eval_prompt_overlap_rejected(self):
        with tempfile.TemporaryDirectory(prefix="mrrobot-finetuning-test-") as directory:
            path = Path(directory)
            exported(path, train=[example("  SAME   Question? ")], evaluation=[example("same question?")])
            with self.assertRaisesRegex(ValueError, "leakage"):
                MODULE.load_export(path)

    def test_models_require_native_local_safetensors_not_custom_code(self):
        with tempfile.TemporaryDirectory(prefix="mrrobot-finetuning-test-") as directory:
            path = Path(directory)
            (path / "config.json").write_text(json.dumps({"auto_map": {"AutoModel": "custom.Model"}}))
            with self.assertRaisesRegex(ValueError, "Custom model code"):
                MODULE.validate_model(path)
            (path / "config.json").write_text(json.dumps({"model_type": "fixture"}))
            with self.assertRaisesRegex(ValueError, "safetensors"):
                MODULE.validate_model(path)

    def test_parameters_are_finite_and_bounded(self):
        args = MODULE.parser().parse_args(["--dataset-dir", "unused", "--learning-rate", "nan"])
        with self.assertRaisesRegex(ValueError, "bounds"):
            MODULE.run(args)


if __name__ == "__main__":
    unittest.main()
