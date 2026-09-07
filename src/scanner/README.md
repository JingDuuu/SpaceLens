# SpaceLens native scanner

Build on Windows with the .NET 9 SDK:

```powershell
dotnet publish src/scanner/SpaceLens.Scanner.csproj -c Release -r win-x64 --self-contained true -o runtime/scanner
node tests/scanner-contract.cjs
```

The published `SpaceLens.Scanner.exe` is a self-contained Windows x64 executable. The destination computer does not need .NET or Node to run the scanner itself.

```powershell
.\runtime\scanner\SpaceLens.Scanner.exe scan --path 'D:\' --output '.\scan.json' --workers 4
```

Standard output is JSON Lines (`progress`, then `complete`); standard error contains structured startup/save errors. Exit code 0 means a snapshot was saved: inspect `status` for `complete`, `partial`, or `cancelled`. Invalid input returns 2, and scan/save failures return 3. Ctrl+C or the stdin line `cancel` requests cooperative cancellation and saves consistent partial totals. JSON output is UTF-8 and atomically replaces its destination after serialization.

## What is measured

`bytes` is **logical file size from directory-entry metadata**. It is not allocated disk space or reclaimable space. Sparse files, compressed files, and cloud placeholders can have much larger logical sizes than physical allocations. Hardlinked files are counted once per directory entry. Files may change while scanning, so a snapshot is a best-effort enumeration, not a transactional filesystem snapshot.

`summary.files` counts file entries. `summary.dirs` counts descendant directories and excludes the root. A directory node's `bytes`, `files`, and `dirs` recursively aggregate recorded descendants. Root node ID is 0; IDs are dense, ordered, and parents precede children. Unreadable and skipped subtrees remain visible as zero-byte directory nodes with warnings, and make status `partial`. `summary.skipped` counts intentionally skipped directory subtrees, not hidden children or metadata-only files. `summary.errors` is the full number of enumeration failures; at most 10,000 detail records are retained, with excess counted in `errorDetailsTruncated`.

Files are never opened and contents are never read. Directory junctions and symbolic links are not followed. Cloud/offline directory subtrees are skipped to avoid provider callbacks. Cloud file placeholders retain logical-size metadata and carry `cloud_placeholder_metadata_only`; their count is `summary.cloudFiles`. Reparse files carry `reparse_file_metadata_only`. Directory metadata enumeration does not intentionally hydrate placeholder contents.

`accessed` and `modified` are raw filesystem timestamps. Last-access timestamps may be disabled, deferred, changed by other programs, or unrelated to application launches. They must not be represented as proof of when a person last used software.

## Engine and limits

Enumeration uses Win32 `FindFirstFileExW` with `FindExInfoBasic` and `FIND_FIRST_EX_LARGE_FETCH`, with a flag fallback for providers that reject large fetch. Extended paths cover long Unicode and UNC names. Workers share a bounded 2,048-directory queue. Overflow is visited depth first by its owning worker; writers never block on a full queue. This avoids producer/consumer deadlocks. The snapshot needs O(number of recorded entries) memory. Every cancellation point closes its native directory handle, then remaining recorded nodes are aggregated in one reverse O(n) pass.

Default worker count is min(4, available processors); `--workers 1..32` permits tuning. Rotational disks and network shares may perform better with fewer workers. The engine does not read NTFS MFT directly and does not require elevation. No claim of universally matching a particular commercial scanner is made; performance depends on media, permissions, provider behavior, file count, antivirus, and filesystem cache. Use the saved fixture and measured benchmark results as scoped evidence.

## Warnings

- `reparse_directory_skipped`: link/junction subtree not followed.
- `cloud_directory_skipped`: offline/recall directory subtree not visited.
- `cloud_placeholder_metadata_only`: logical file metadata only, no content access.
- `reparse_file_metadata_only`: reparse file metadata only.
- `directory_unreadable`: cannot begin enumerating a directory.
- `directory_enumeration_incomplete`: an enumeration ended with a filesystem error.
- `scan_cancelled`: directory metadata was recorded, but enumeration did not finish.

The scanner has no deletion or execution command.

## Primary references

- [Microsoft: FindFirstFileExW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-findfirstfileexw) documents the native enumeration flags, extended paths, and metadata race limits.
- [Microsoft: File attribute constants](https://learn.microsoft.com/en-us/windows/win32/fileio/file-attribute-constants) defines offline and recall attributes, including remote-provider costs of enumerating recall directories.
- [Microsoft: WIN32_FIND_DATAW](https://learn.microsoft.com/en-us/windows/win32/api/minwinbase/ns-minwinbase-win32_find_dataw) specifies the returned sizes and timestamps.
