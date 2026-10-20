# Mounts on Windows

Each [workspace](workspaces.md) of Buckle, the approval and sandbox runtime on this machine, has
a [mount table](mounts.md). This page says what a Windows node adds to it: a network share as a
mount's source.

## Windows shares

On Windows a mount's source may be a network share (`\\server\share\folder`), and a mapped
drive is stored as the share it points to, since a node started by another logon does not see
the letter. A path on a share is reached only inside a mount that holds it: a workspace folder,
the state directory, and every other path on a share stay refused, and so does a device path
(`\\?\` or `\\.\`). A program on a share runs only from a read-only mount, as a writable mount is
a place an agent can write.
