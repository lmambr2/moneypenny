# Patches on tsclient-rs 0.1.3

Upstream: <https://github.com/dreamhax/tsclient-rs> `0.1.3`.

1. **Voice packet id wrap (debug overflow).** `packet_counter` is `u16`.
   `(p_id + 1) & 0xffff` panics in debug at 65535 because `+` is checked
   before the mask. Music is 50 frames/s → ~22 minutes. Use
   `wrapping_add` (same wrap as release).
2. **`close()` poison.** After that panic, `Mutex::lock().unwrap()` in
   `close()` panics again. Recover with `into_inner()`.
