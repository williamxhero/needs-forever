# Candidate patch 0.3.1

Parent reported that the supported CLI twice refused an in-place same-version 0.3.0 update with Windows `failed to back up plugin cache entry (os error 5)`. Existing installation, legacy package and root-hook hashes remained unchanged. This patch creates a normal new 0.3.1 version rather than attempting to overwrite the installed version or altering trust/security configuration. Whether the real host can activate this version remains a parent-owned live installation check.

Core package, both lockfile version fields, plugin package and canonical hidden manifest now consistently declare 0.3.1; current README names the new candidate. The packaging contract additionally checks those version fields agree. Original 0.3.0 candidate archives and evidence are preserved.

`npm run plugin:build` passed (17 modules). `patch031-packaging-checks.txt` records **5/5 passing** packaging, installed-copy lifecycle, and isolated discovery tests. Isolated discovery uses the replacement install host and does not prove real Desktop effectiveness.

`patch031-package.json` contains the archive path, SHA256, all 28 installed-package file hashes and successful extraction/source parity. SHA256: `8b4918792c3863350df05164ebdf70840d9246390d207eaa636f6ef12cf667c9`. Comparing every packaged file against reviewed 0.3.0 confirms that only `plugins/needs-forever/package.json` and `plugins/needs-forever/.codex-plugin/plugin.json` differ. All executable scripts, runtime, hooks, skills and resources remain byte-identical to reviewed commit `5f665c6962d03e22335f1bbe16aee9829edca3c2`.

No global installation, trust changes, chat/model creation or actual Desktop acceptance occurred in this patch. Parent owns integration, supported-CLI activation and native acceptance.
