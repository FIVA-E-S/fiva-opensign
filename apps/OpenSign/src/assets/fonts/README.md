# PDF Font

`times.ttf` is the existing OpenSign server font from
`apps/OpenSignServer/font/times.ttf`, copied without modification.

The client bundles the same font for document IDs and form widgets so preparing
the signed PDF does not depend on `cdn.opensignlabs.com`. Keep this file aligned
with the server font. No signing, consent or certificate behavior is changed.
