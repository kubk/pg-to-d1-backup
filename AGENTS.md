# Releasing

To release, wait for CI to pass on `main`, tag the commit `vX.Y.Z`, force-push the major tag `vX` to the same commit, and create a GitHub release for `vX.Y.Z`. Start a new major version only for changes that break existing workflows.
