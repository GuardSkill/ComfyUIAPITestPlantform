# Batch Workflow Tester

The `batch_workflow_tester.py` helper lets you queue multiple ComfyUI workflows in one run, upload the required assets automatically, and collect every generated image or video in a single output directory. It is designed for quick regression testing of new workflow templates.

## Quick Start

1. Copy the example configuration and adjust it to match your assets:
   ```powershell
   Copy-Item workflow_test_config.example.json workflow_test_config.json
   ```
2. Edit `workflow_test_config.json`:
   - Point `workflow_path` to each JSON workflow you want to test.
   - Supply local files for every placeholder such as `input_image`, `input_image_l`, `input_image_r`, or `input_video`. The script uploads these before execution.
   - (Optional) Override prompts or other node inputs through the `text_inputs` and `overrides` sections (see below for details).
3. Run the batch tester:
   ```powershell
   python batch_workflow_tester.py --config workflow_test_config.json
   ```
4. Find results and run metadata under `workflow_test_output/<workflow_name>/<timestamp>/`. Each saved file is prefixed with the node id and output type so you can trace it back to the workflow.

Use `--workflow name` to limit the run to a single entry, `--server URL` to point at another ComfyUI instance, and `--log-level DEBUG` for verbose tracing.

## Configuration Reference

| Field | Description |
| ----- | ----------- |
| `server` | Base URL of the ComfyUI API. Mix `http://` with the regular port (`8188` by default). |
| `output_dir` | Root directory for saving all run artifacts. A timestamped folder is created per workflow. |
| `workflows` | Array describing each batch item. Every entry must contain `name`, `workflow_path`, and may define `inputs`, `text_inputs`, `overrides`, `output_dir`. |
| `inputs` | Map placeholder → local asset. A simple string uploads the file with an inferred endpoint. Use an object for more control:<br>`{"path": "...", "upload_type": "video"}` or `{"path": "...", "upload": false, "name": "existing.png"}` to reuse a file already on the server. |
| `text_inputs` | Map of node identifiers to the replacement input values. Use `id:<node_id>` to target a specific node, or the node title (from `_meta.title`) to affect multiple nodes. |
| `overrides` | Works like `text_inputs` but allows modifying any nested value. For granular edits use dot-paths such as `{"123.inputs.cfg": 4.5}`. |
| `output_dir` (entry-level) | Overrides the global output directory for a single workflow entry. |

The configuration file must stay valid JSON (no comments). Keep asset paths relative to the repository root so the script can discover them easily.

## Error Handling

- Upload failures or missing files raise immediately with descriptive messages.
- API-side failures (reported in the websocket channel) raise a `ComfyAPIError`; the run is marked as failed but the script continues with the next workflow.
- Each run writes a `run_metadata.json` file alongside the outputs so you can trace the prompt id, status payload, and saved asset paths.

If you need to add support for a new placeholder name, simply extend the `inputs` section in your config—the script replaces any string that matches the uploaded key anywhere inside the workflow JSON. For advanced parameter tweaks, combine `text_inputs` with fine-grained `overrides` to reach whichever node needs to change.
