# Maintained Zero 1.9.0

This fork backports database lifetime repairs while keeping Zero 1.9.0's wire
protocol 51, storage format, exports and dependency versions. It is not an
official Rocicorp release. The Apache 2.0 license and original attribution apply.

The upstream fixes are submitted as [PR 6740](https://github.com/rocicorp/mono/pull/6740)
and [PR 6741](https://github.com/rocicorp/mono/pull/6741). Temporary collector stores
and drop registries close after use. Explicit client close drains persistence,
refresh and active queries, then releases only that client's snapshot pins. Client
identity, group state and persisted pending mutations remain intact. Crashes still
use upstream's normal garbage collection. No data is wiped and no automatic
VACUUM runs.

The backport tracks in-flight refreshes and uses the existing persistence lock
because 1.9.0 predates the separate stopPersist and stopRefresh APIs. The two
modified JavaScript files omit their original source maps, which describe the
unpatched code. All other runtime files retain their original bytes.

Build with Node 22.18 or newer:

```sh
node --experimental-strip-types maintained-zero/build.ts /absolute/empty/output
```

For the integration probe, install the package's dependencies in its extracted
directory, then run `node --experimental-strip-types maintained-zero/verify.ts
/absolute/extracted/package`. It exercises two concurrent clients, persisted
pending mutations, an in-flight query during close, reopen, collector inspection
and propagation, and the lifetime of every created store handle. The original
1.9.0 package fails the snapshot assertion; retaining only its original collector
fails the temporary-store lifetime assertion.

The build verifies the original npm tarball's SHA-512 before applying the patch.
The output is an npm-installable tarball named `natew-zero-1.9.0-orez.1.tgz`.
Its package metadata records this fork's source commit and the upstream integrity.
Keep consumer-specific patches, including statement serialization and startup
garbage collection, applied after installing this package.

The latest stable 1.11.4 and canary 1.12.0-canary.12 were inspected on November 5,
2026 and contain neither repair. They use protocols 53 and 57 respectively, so
this backport avoids an unrelated protocol migration. Replace this fork with an
official release once it includes the repairs and its protocol is supported.
