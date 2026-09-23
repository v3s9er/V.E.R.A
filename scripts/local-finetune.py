#!/usr/bin/env python3
"""Optional OFFLINE local LoRA/QLoRA trainer. No model download, shell, upload, or auto-install.

Default invocation validates an explicitly exported dataset and reports prerequisites.
Actual GPU training additionally requires --train --confirm-local-training and --model-dir.
Only locally reviewed safetensors checkpoints are accepted. This is not Codex fine-tuning.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import importlib.util
import inspect
import json
import math
import os
from pathlib import Path
import re
import sys
import unicodedata

# Set before importing any ML libraries. report_to=[], push_to_hub=False are also enforced.
for _name in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_DATASETS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY", "DO_NOT_TRACK"):
    os.environ[_name] = "1"
os.environ["WANDB_DISABLED"] = "true"
os.environ["TOKENIZERS_PARALLELISM"] = "false"

MAX_BYTES = 4 * 1024 * 1024
MAX_ROWS = 2000
DEPENDENCIES = ("torch", "transformers", "datasets", "peft", "trl", "accelerate", "safetensors")


def fail(message: str) -> None:
    raise ValueError(message)


def regular_file(path: Path, limit: int = MAX_BYTES) -> bytes:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > limit:
        fail("Input must be a bounded regular file, not a symlink.")
    return path.read_bytes()


def normalize(text: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", text).lower().split())


def credential_risk(text: str) -> bool:
    patterns = (
        r"-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----",
        r"\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[0-9A-Za-z-]{10,}|cfast_[A-Za-z0-9]{48})\b",
        r"\b(?:[MNO][A-Za-z0-9_-]{22,30}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}|mfa\.[A-Za-z0-9_-]{80,})\b",
        r"dpapi:v1(?::|/)[A-Za-z0-9+/=]{16,}",
        r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b",
        r"(?i)\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|passwd|authorization)\s*[=:]\s*[\"']?(?:bearer\s+)?[A-Za-z0-9_+/.=-]{8,}",
        r"(?i)\bBearer\s+[A-Za-z0-9_.~+/-]{16,}",
        r"(?i)\b[a-z][a-z0-9+.-]*://[^\s/@:]+:[^\s/@]+@",
    )
    return any(re.search(pattern, text) for pattern in patterns)


def read_rows(raw: bytes) -> list[dict]:
    rows = []
    for line_number, line in enumerate(raw.decode("utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except (ValueError, UnicodeError):
            fail(f"Invalid JSON on row {line_number}; contents omitted.")
        if not isinstance(row, dict) or set(row) != {"messages"} or not isinstance(row["messages"], list) or not 2 <= len(row["messages"]) <= 64:
            fail(f"Invalid chat schema on row {line_number}.")
        expected = "user"
        for index, message in enumerate(row["messages"]):
            if not isinstance(message, dict) or set(message) != {"role", "content"} or not isinstance(message["content"], str) or not message["content"].strip() or len(message["content"].encode("utf-8")) > 32768:
                fail(f"Invalid message on row {line_number}.")
            if credential_risk(message["content"]):
                fail(f"Possible credential on row {line_number}; training blocked.")
            if message["role"] == "system" and index == 0:
                continue
            if message["role"] != expected:
                fail(f"Invalid role order on row {line_number}.")
            expected = "assistant" if expected == "user" else "user"
        if row["messages"][-1]["role"] != "assistant":
            fail(f"Final message must be assistant on row {line_number}.")
        rows.append(row)
        if len(rows) > MAX_ROWS:
            fail("Too many dataset rows.")
    if not rows:
        fail("Both train and evaluation datasets must be nonempty.")
    return rows


def load_export(directory: Path) -> tuple[dict, list[dict], list[dict]]:
    if directory.is_symlink() or not directory.is_dir():
        fail("Export directory must be an existing non-symlink directory.")
    manifest = json.loads(regular_file(directory / "manifest.json", 32768))
    if manifest.get("version") != 1 or manifest.get("kind") != "mr-robot-local-sft" or manifest.get("privacyReviewed") is not True or manifest.get("network") != "disabled":
        fail("Use a reviewed export from Mr.Robot's local tuning dataset preparation.")
    raw_train = regular_file(directory / "train.jsonl")
    raw_eval = regular_file(directory / "eval.jsonl")
    for name, raw in (("train", raw_train), ("eval", raw_eval)):
        if hashlib.sha256(raw).hexdigest() != manifest.get(f"{name}Sha256"):
            fail(f"{name} dataset checksum mismatch. Re-export instead of editing prepared files.")
    train, evaluation = read_rows(raw_train), read_rows(raw_eval)
    def prompts(rows: list[dict]) -> set[str]:
        return {normalize(message["content"]) for row in rows for message in row["messages"] if message["role"] == "user"}
    if prompts(train) & prompts(evaluation):
        fail("User-prompt leakage between train and held-out data. Re-export the dataset.")
    counts = manifest.get("dataset", {}).get("counts", {})
    if counts.get("trainRows") != len(train) or counts.get("evalRows") != len(evaluation):
        fail("Dataset row counts do not match manifest.")
    return manifest, train, evaluation


def dependency_report() -> dict:
    report = {}
    for name in DEPENDENCIES + ("bitsandbytes",):
        try:
            report[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            report[name] = None
    return report


def hardware_report() -> dict:
    if importlib.util.find_spec("torch") is None:
        return {"checked": False, "reason": "PyTorch is not installed"}
    try:
        import torch
        result = {"checked": True, "cuda": bool(torch.cuda.is_available()), "gpus": []}
        if result["cuda"]:
            for index in range(torch.cuda.device_count()):
                properties = torch.cuda.get_device_properties(index)
                result["gpus"].append({"index": index, "name": properties.name, "vramGiB": round(properties.total_memory / (1024 ** 3), 2)})
        return result
    except Exception:
        return {"checked": False, "reason": "PyTorch hardware probe failed; check the local installation"}


def validate_model(path: Path) -> dict:
    if path.is_symlink() or not path.is_dir():
        fail("Choose a reviewed local model directory; Hub model IDs and links are not accepted.")
    config = json.loads(regular_file(path / "config.json", 1024 * 1024))
    if config.get("auto_map"):
        fail("Custom model code (auto_map) is not allowed; choose a Transformers-native model.")
    weight_files = list(path.glob("*.safetensors"))
    if not weight_files or any(item.is_symlink() or not item.is_file() for item in weight_files):
        fail("A complete local safetensors model is required; pickle weights are not accepted.")
    return {"modelType": str(config.get("model_type", "unknown"))[:100], "weightGiB": round(sum(item.stat().st_size for item in weight_files) / (1024 ** 3), 3)}


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--dataset-dir", required=True, type=Path)
    result.add_argument("--model-dir", type=Path)
    result.add_argument("--train", action="store_true", help="Actually train; absent means dry-run only")
    result.add_argument("--confirm-local-training", action="store_true", help="Confirm reviewed data/model license and local GPU use")
    result.add_argument("--allow-cpu", action="store_true", help="Explicitly allow potentially slow CPU training")
    result.add_argument("--quantization", choices=("none", "nf4"), default="none")
    result.add_argument("--rank", type=int, default=8)
    result.add_argument("--learning-rate", type=float, default=1e-4)
    result.add_argument("--epochs", type=float, default=1.0)
    result.add_argument("--max-steps", type=int, default=100)
    result.add_argument("--max-length", type=int, default=1024)
    result.add_argument("--gradient-accumulation", type=int, default=8)
    return result


def run(args: argparse.Namespace) -> dict:
    if args.rank not in (4, 8, 16, 32, 64) or not 1e-7 <= args.learning_rate <= 1e-2 or not 0 < args.epochs <= 10 or not 1 <= args.max_steps <= 10000 or not 128 <= args.max_length <= 8192 or not 1 <= args.gradient_accumulation <= 64:
        fail("Training parameters exceed supported bounds.")
    manifest, train, evaluation = load_export(args.dataset_dir)
    deps = dependency_report()
    hardware = hardware_report()
    model_info = validate_model(args.model_dir) if args.model_dir else None
    report = {"mode": "dry-run", "network": "disabled", "trainingStarted": False, "trainRows": len(train), "evalRows": len(evaluation), "dependencies": deps, "hardware": hardware, "model": model_info,
              "limits": {"maxSteps": args.max_steps, "epochs": args.epochs, "maxLength": args.max_length, "rank": args.rank},
              "note": "Readiness is not a memory-fit guarantee or a quality result. No files downloaded, no model loaded, no training started."}
    if not args.train:
        return report
    if not args.confirm_local_training or args.model_dir is None:
        fail("Training requires --train --confirm-local-training --model-dir after reviewing the dry-run.")
    missing = [name for name in DEPENDENCIES if not deps[name]]
    if args.quantization == "nf4" and not deps["bitsandbytes"]:
        missing.append("bitsandbytes")
    if missing:
        fail("Missing optional dependencies: " + ", ".join(missing) + ". Install and review them yourself in a dedicated virtual environment; nothing was installed.")
    if not hardware.get("cuda") and not args.allow_cpu:
        fail("CUDA is unavailable; choose a supported local GPU or explicitly opt into --allow-cpu.")
    if args.quantization == "nf4" and not hardware.get("cuda"):
        fail("This reviewed NF4 workflow requires a supported CUDA GPU.")

    import torch
    from datasets import Dataset
    from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
    from peft import LoraConfig, prepare_model_for_kbit_training
    from trl import SFTConfig, SFTTrainer

    required_config = {"completion_only_loss", "max_length", "eval_strategy", "report_to", "push_to_hub"}
    if not required_config.issubset(inspect.signature(SFTConfig).parameters) or "processing_class" not in inspect.signature(SFTTrainer).parameters:
        fail("Installed TRL API is incompatible. Review a current release supporting SFTConfig and processing_class; no automatic upgrade is performed.")
    # The source/adapter location stays under the selected private export. Never overwrite a prior run.
    from datetime import datetime, timezone
    output = args.dataset_dir.resolve() / "runs" / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    if output.parent.is_symlink() or output.exists():
        fail("Output is a link or already exists.")
    tokenizer = AutoTokenizer.from_pretrained(str(args.model_dir.resolve()), local_files_only=True, trust_remote_code=False)
    if not tokenizer.chat_template or not tokenizer.eos_token:
        fail("The local tokenizer must include a reviewed chat template and EOS token.")
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    for rows in (train, evaluation):
        for index, row in enumerate(rows):
            tokens = tokenizer.apply_chat_template(row["messages"], tokenize=True)
            if len(tokens) > args.max_length:
                fail(f"Example {index + 1} exceeds --max-length. Shorten it or explicitly increase the limit; silent truncation is disabled.")
    use_bf16 = bool(hardware.get("cuda") and torch.cuda.is_bf16_supported())
    dtype = torch.bfloat16 if use_bf16 else torch.float32
    model_kwargs = {"local_files_only": True, "trust_remote_code": False, "use_safetensors": True, "torch_dtype": dtype}
    if args.quantization == "nf4":
        model_kwargs["quantization_config"] = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True, bnb_4bit_compute_dtype=dtype)
        model_kwargs["device_map"] = {"": 0}
    model = AutoModelForCausalLM.from_pretrained(str(args.model_dir.resolve()), **model_kwargs)
    if args.quantization == "nf4":
        model = prepare_model_for_kbit_training(model)
    model.config.use_cache = False
    seed = int(hashlib.sha256(manifest["dataset"]["seed"].encode()).hexdigest()[:8], 16)
    effective_steps = min(args.max_steps, max(1, math.ceil(math.ceil(len(train) / args.gradient_accumulation) * args.epochs)))
    config = SFTConfig(output_dir=str(output), per_device_train_batch_size=1, per_device_eval_batch_size=1,
                       gradient_accumulation_steps=args.gradient_accumulation, num_train_epochs=args.epochs,
                       max_steps=effective_steps, learning_rate=args.learning_rate, max_length=args.max_length,
                       completion_only_loss=True, packing=False, gradient_checkpointing=True,
                       bf16=use_bf16, fp16=False, use_cpu=not hardware.get("cuda"), optim="adamw_torch",
                       eval_strategy="no", save_strategy="no", logging_steps=10, report_to=[], push_to_hub=False,
                       seed=seed, data_seed=seed, dataloader_num_workers=0)
    def completion_rows(rows: list[dict]) -> list[dict]:
        return [{"prompt": row["messages"][:-1], "completion": row["messages"][-1:]} for row in rows]
    trainer = SFTTrainer(model=model, args=config, processing_class=tokenizer,
                         train_dataset=Dataset.from_list(completion_rows(train)), eval_dataset=Dataset.from_list(completion_rows(evaluation)),
                         peft_config=LoraConfig(r=args.rank, lora_alpha=args.rank * 2, lora_dropout=0.05,
                                                target_modules="all-linear", bias="none", task_type="CAUSAL_LM"))
    before = trainer.evaluate()
    trainer.train()
    after = trainer.evaluate()
    trainer.save_model(str(output))
    tokenizer.save_pretrained(str(output))
    result = {"mode": "trained", "network": "disabled", "trainingStarted": True, "adapterDirectory": str(output),
              "beforeEvalLoss": before.get("eval_loss"), "afterEvalLoss": after.get("eval_loss"), "dependencies": deps,
              "datasetId": manifest["dataset"]["id"], "trainRows": len(train), "evalRows": len(evaluation),
              "warning": "Lower held-out loss alone does not establish better agent behavior. Run task quality, safety and latency regression checks before deployment. Not auto-activated."}
    (output / "mr-robot-training-report.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def main() -> int:
    try:
        print(json.dumps(run(parser().parse_args()), ensure_ascii=False, indent=2))
        return 0
    except (ValueError, OSError, KeyError, TypeError) as error:
        # Do not expose private row bodies or library diagnostic dumps through automatic logs.
        print(json.dumps({"ok": False, "error": str(error)[:500]}, ensure_ascii=False), file=sys.stderr)
        return 1
    except Exception:
        print(json.dumps({"ok": False, "error": "Local training failed. Check model/library compatibility and available GPU memory locally; no upload or automatic retry occurred."}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
