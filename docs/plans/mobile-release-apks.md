# Mobile APK release assets

The Mobile artifacts workflow builds Android phone/tablet and Android TV APKs as workflow artifacts. When the corresponding builds succeed and release publishing is enabled, attach both APKs to the same GitHub Release as the iOS IPA.

The publish job must remain tolerant of a failed or disabled Android build so iOS and Pages publishing can continue. APK upload must also run on release retries where the release already exists and the IPA has caused release creation to be skipped; use clobbering uploads so retries are idempotent.
