# Fixture provenance

Generated on this machine for readiness tests.

- `xz-preset6.bin`: `xz -z -c --format=xz -6 < source.txt` (xz xz (XZ Utils) 5.8.3)
  - source sha256: `297a4f5bd3c0dbb5c9051422073cc9c798ad6037f99b0be2a05fdd18fa66793d`
  - compressed sha256: `c7d3526905e0ff0dfe80485ea9f68205d0cb779dd47626f697b695b0ddd1739d`
- `lzma-preset6.bin`: `xz -z -c --format=lzma -6 < source.txt` (xz xz (XZ Utils) 5.8.3)
  - source sha256: `297a4f5bd3c0dbb5c9051422073cc9c798ad6037f99b0be2a05fdd18fa66793d`
  - compressed sha256: `701e2e6585d02e7d1841d40ef6a9888100a71db106608f460bb6156e35ae9060`
- `lzip-preset6.bin`: `lzip -c -6 < source.txt` (lzip lzip 1.26)
  - source sha256: `297a4f5bd3c0dbb5c9051422073cc9c798ad6037f99b0be2a05fdd18fa66793d`
  - compressed sha256: `abd95ad2583d780e483ad5f6ebb731bbbad5232a3c9d60e6f225d6f890ae85f3`
- `xz-empty.bin`: `xz -z -c --format=xz < /dev/null` (xz (XZ Utils) 5.8.3)
  - source sha256: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
  - compressed sha256: `0040f94d11d0039505328a90b2ff48968db873e9e7967307631bf40ef5679275`
