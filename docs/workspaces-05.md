# Serving workspaces

Buckle, the approval and sandbox runtime on this machine, serves its [workspaces](workspaces.md)
from one node, started with `buckle serve`. This page says what that command does and shows.

`buckle serve` serves every online workspace, and opens each at start, so a broken one is named
then rather than at its first call; the rest are served. On its terminal it lists them, each with
its id and name, where the agent sees its folder and from where, its URL mode, and the packs it
offers, and lists them again after each change. Every question it asks is marked with the
workspace it waits in.
