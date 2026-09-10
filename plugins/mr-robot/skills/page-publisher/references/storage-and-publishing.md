# Storage and publishing

## Storage commands

The default root is `%USERPROFILE%\.mr-robot` on Windows and `~/.mr-robot` elsewhere. Set `MR_ROBOT_HOME` or pass `--root <path>` to isolate a library.

`save` accepts either a directory or one HTML file. When a site already exists, its current `source/` becomes a timestamped revision before replacement. Generated folders such as `.git`, `node_modules`, and `dist` are omitted, and symbolic links are rejected.

`delete` is reversible: it moves the whole site into `trash/`. `restore` selects the newest matching trash entry unless `--entry` names one.

## Cloudflare Workers

`build_worker.py` embeds the page files in `worker.mjs` and creates `wrangler.jsonc` plus `build-manifest.json`. It does not deploy anything.

Before publishing, verify that Wrangler is already available and authenticated:

```text
wrangler --version
wrangler whoami
```

Then deploy from the generated output directory:

```text
wrangler deploy --config wrangler.jsonc
```

If Wrangler is unavailable, follow the active environment's rules before installing or running a newly downloaded copy. The Cloudflare dashboard is an acceptable fallback.

The default configuration publishes to the account's `workers.dev` subdomain. A domain such as `page.example.com` requires a separate Cloudflare Custom Domain or route configuration; owning a domain does not attach it automatically.

After success, record the result:

```text
python site_manager.py mark-published <site> --provider cloudflare-workers --url <https-url> --deployment <worker-name>
```

To pause a page without losing its source, deploy a small `503 Offline` worker and then run `mark-offline`. To restore it, rebuild the saved source and deploy again. Deleting a Cloudflare Worker or custom-domain route is separate from deleting the local draft and requires an explicit request for that provider-side deletion.

## Rollback

Use `history` to choose a revision, then `restore-revision`. Rebuild and preview the restored source before publishing it. A rollback changes the draft first; it does not silently change the live deployment.
