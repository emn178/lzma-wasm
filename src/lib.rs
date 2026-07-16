use lzma_rust2::{
    LzipOptions, LzipReader, LzipWriter, LzmaOptions, LzmaReader, LzmaWriter, XzOptions, XzReader,
    XzWriter,
};
use std::io::{Read, Write};
use wasm_bindgen::prelude::*;

const XZ_MAGIC: &[u8] = &[0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00];
const LZIP_MAGIC: &[u8] = &[0x4C, 0x5A, 0x49, 0x50];
/// LZIP member header size (magic + version + dict size). Incomplete headers are truncated.
const LZIP_HEADER_SIZE: usize = 6;
const LZIP_TRAILER_SIZE: usize = 20;
const LZIP_VERSION: u8 = 1;
const LZIP_MIN_DICT_SIZE: u32 = 4 * 1024;
const LZIP_MAX_DICT_SIZE: u32 = 512 * 1024 * 1024;
const READ_CHUNK: usize = 64 * 1024;

enum AutoReader<'a> {
    Lzma(LzmaReader<&'a [u8]>),
    Xz(XzReader<&'a [u8]>),
}

impl<'a> Read for AutoReader<'a> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            AutoReader::Lzma(r) => r.read(buf),
            AutoReader::Xz(r) => r.read(buf),
        }
    }
}

/// Mirror of lzma-rust2 dictionary-size decoding so we reject malformed headers
/// before upstream `LzipReader` treats a parse failure as empty EOF.
fn decode_lzip_dict_size(encoded: u8) -> Result<u32, String> {
    let base_log2 = (encoded & 0x1F) as u32;
    let fraction_num = (encoded >> 5) as u32;

    if !(12..=29).contains(&base_log2) {
        return Err("Invalid LZIP dictionary size".to_string());
    }
    if fraction_num > 7 {
        return Err("Invalid LZIP dictionary size".to_string());
    }

    let base_size = 1u32 << base_log2;
    let fraction_size = if base_log2 >= 4 {
        (base_size >> 4) * fraction_num
    } else {
        0
    };
    let dict_size = base_size - fraction_size;
    if !(LZIP_MIN_DICT_SIZE..=LZIP_MAX_DICT_SIZE).contains(&dict_size) {
        return Err("Invalid LZIP dictionary size".to_string());
    }
    Ok(dict_size)
}

fn validate_lzip_header(data: &[u8]) -> Result<(), String> {
    if data.len() < LZIP_HEADER_SIZE {
        return Err("Truncated LZIP stream".to_string());
    }
    if !data.starts_with(LZIP_MAGIC) {
        return Err("Invalid LZIP magic".to_string());
    }
    if data[4] != LZIP_VERSION {
        return Err("Unsupported LZIP version".to_string());
    }
    decode_lzip_dict_size(data[5])?;
    Ok(())
}

/// Walk LZIP members from the trailer end (same approach as lzma-rust2 `scan_members`).
/// Requires that members cover the buffer exactly from offset 0, and validates every header.
fn scan_lzip_members(data: &[u8]) -> Result<usize, String> {
    let file_size = data.len();
    if file_size < LZIP_HEADER_SIZE + LZIP_TRAILER_SIZE {
        return Err("Truncated LZIP stream".to_string());
    }

    let mut member_count = 0usize;
    let mut current_pos = file_size;

    while current_pos > 0 {
        if current_pos < LZIP_TRAILER_SIZE {
            return Err("Trailing or malformed data after LZIP stream".to_string());
        }

        let trailer_start = current_pos - LZIP_TRAILER_SIZE;
        let trailer = &data[trailer_start..current_pos];
        let member_size = u64::from_le_bytes([
            trailer[12],
            trailer[13],
            trailer[14],
            trailer[15],
            trailer[16],
            trailer[17],
            trailer[18],
            trailer[19],
        ]);

        if member_size == 0 || member_size as usize > current_pos {
            return Err("Invalid LZIP member size in trailer".to_string());
        }
        if (member_size as usize) < LZIP_HEADER_SIZE + LZIP_TRAILER_SIZE {
            return Err("Invalid LZIP member size in trailer".to_string());
        }

        let member_start = current_pos - member_size as usize;
        validate_lzip_header(&data[member_start..])?;
        member_count += 1;
        current_pos = member_start;
    }

    if member_count == 0 {
        return Err("No valid LZIP members found".to_string());
    }
    Ok(member_count)
}

fn detect_non_lzip_reader(compressed: &[u8], mem_limit: u32) -> Result<AutoReader<'_>, String> {
    if compressed.starts_with(XZ_MAGIC) {
        Ok(AutoReader::Xz(XzReader::new(compressed, true)))
    } else {
        LzmaReader::new_mem_limit(compressed, mem_limit, None)
            .map(AutoReader::Lzma)
            .map_err(|e| format!("Decompression read failed: {e}"))
    }
}

fn read_into_buffer<R: Read>(
    reader: &mut R,
    out_buffer: &mut [u8],
) -> Result<usize, String> {
    let mut total_read = 0usize;
    let out_len = out_buffer.len();

    loop {
        if total_read >= out_len {
            let mut probe = [0u8; 1];
            let n = reader
                .read(&mut probe)
                .map_err(|e| format!("Decompression read failed: {e}"))?;
            if n > 0 {
                return Err(
                    "Destination buffer is too small for decompressed output".to_string(),
                );
            }
            break;
        }

        let n = reader
            .read(&mut out_buffer[total_read..])
            .map_err(|e| format!("Decompression read failed: {e}"))?;
        if n == 0 {
            break;
        }
        total_read += n;
    }

    Ok(total_read)
}

fn read_dynamic<R: Read>(
    reader: &mut R,
    max_output_size: Option<u32>,
) -> Result<Vec<u8>, String> {
    let max_output = max_output_size.map(|n| n as usize);
    let mut decompressed = match max_output {
        Some(limit) => Vec::with_capacity(limit.min(READ_CHUNK)),
        None => Vec::new(),
    };
    let mut chunk = vec![0u8; READ_CHUNK];

    loop {
        let n = reader
            .read(&mut chunk)
            .map_err(|e| format!("Decompression failed: {e}"))?;
        if n == 0 {
            break;
        }
        if let Some(limit) = max_output {
            if decompressed.len().saturating_add(n) > limit {
                return Err("Decompressed output exceeds maxOutputSize".to_string());
            }
        }
        decompressed.extend_from_slice(&chunk[..n]);
    }

    Ok(decompressed)
}

fn decompress_lzip_to_buffer(compressed: &[u8], out_buffer: &mut [u8]) -> Result<usize, String> {
    // Validate full member coverage before decoding. Do not rely on into_inner():
    // upstream LzipReader may consume trailing malformed bytes and report EOF.
    scan_lzip_members(compressed)?;
    let mut reader = LzipReader::new(compressed);
    read_into_buffer(&mut reader, out_buffer)
}

fn decompress_lzip_dynamic(
    compressed: &[u8],
    max_output_size: Option<u32>,
) -> Result<Vec<u8>, String> {
    scan_lzip_members(compressed)?;
    let mut reader = LzipReader::new(compressed);
    read_dynamic(&mut reader, max_output_size)
}

fn decompress_to_buffer_inner(
    compressed: &[u8],
    out_buffer: &mut [u8],
    mem_limit: u32,
) -> Result<usize, String> {
    if compressed.starts_with(LZIP_MAGIC) {
        return decompress_lzip_to_buffer(compressed, out_buffer);
    }
    let mut reader = detect_non_lzip_reader(compressed, mem_limit)?;
    read_into_buffer(&mut reader, out_buffer)
}

fn decompress_dynamic_inner(
    compressed: &[u8],
    mem_limit: u32,
    max_output_size: Option<u32>,
) -> Result<Vec<u8>, String> {
    if compressed.starts_with(LZIP_MAGIC) {
        return decompress_lzip_dynamic(compressed, max_output_size);
    }
    let mut reader = detect_non_lzip_reader(compressed, mem_limit)?;
    read_dynamic(&mut reader, max_output_size)
}

fn compress_lzma_inner(input: &[u8], level: u32) -> Result<Vec<u8>, String> {
    let mut options = LzmaOptions::default();
    options.set_preset(level);
    let mut writer = LzmaWriter::new_use_header(Vec::new(), &options, Some(input.len() as u64))
        .map_err(|e| format!("Failed to initialize LzmaWriter: {e}"))?;
    writer
        .write_all(input)
        .map_err(|e| format!("Write failed: {e}"))?;
    writer
        .finish()
        .map_err(|e| format!("Finalization failed: {e}"))
}

fn compress_xz_inner(input: &[u8], level: u32) -> Result<Vec<u8>, String> {
    let mut options = XzOptions::default();
    options.lzma_options.set_preset(level);
    let mut writer = XzWriter::new(Vec::new(), options)
        .map_err(|e| format!("Failed to initialize LzmaXzWriter: {e}"))?;
    writer
        .write_all(input)
        .map_err(|e| format!("XZ write failed: {e}"))?;
    writer
        .finish()
        .map_err(|e| format!("XZ finalization failed: {e}"))
}

fn compress_lzip_inner(input: &[u8], level: u32) -> Result<Vec<u8>, String> {
    let mut options = LzipOptions::default();
    options.lzma_options.set_preset(level);
    let mut writer = LzipWriter::new(Vec::new(), options);
    writer
        .write_all(input)
        .map_err(|e| format!("LZIP write failed: {e}"))?;
    writer
        .finish()
        .map_err(|e| format!("LZIP finalization failed: {e}"))
}

fn to_js_err(err: String) -> JsValue {
    JsValue::from_str(&err)
}

/// Decompress into a caller-provided buffer.
///
/// Returns the number of bytes written. If the decoded stream would need more
/// space than `out_buffer`, returns a destination-too-small error instead of a
/// truncated success.
#[wasm_bindgen]
pub fn decompress_to_buffer(
    compressed: &[u8],
    out_buffer: &mut [u8],
    mem_limit: u32,
) -> Result<usize, JsValue> {
    decompress_to_buffer_inner(compressed, out_buffer, mem_limit).map_err(to_js_err)
}

/// Decompress with dynamic growth, optionally capping decompressed output size.
///
/// `max_output_size` is the maximum number of decompressed bytes. Pass `None`
/// for no output-size cap. This is independent of `mem_limit`, which only
/// applies to LZMA-Alone decoder memory.
#[wasm_bindgen]
pub fn decompress_dynamic(
    compressed: &[u8],
    mem_limit: u32,
    max_output_size: Option<u32>,
) -> Result<Vec<u8>, JsValue> {
    decompress_dynamic_inner(compressed, mem_limit, max_output_size).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn compress_lzma(input: &[u8], level: u32) -> Result<Vec<u8>, JsValue> {
    compress_lzma_inner(input, level).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn compress_xz(input: &[u8], level: u32) -> Result<Vec<u8>, JsValue> {
    compress_xz_inner(input, level).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn compress_lzip(input: &[u8], level: u32) -> Result<Vec<u8>, JsValue> {
    compress_lzip_inner(input, level).map_err(to_js_err)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip_formats(payload: &[u8]) {
        for (name, compress_fn) in [
            ("xz", compress_xz_inner as fn(&[u8], u32) -> Result<Vec<u8>, String>),
            ("lzma", compress_lzma_inner),
            ("lzip", compress_lzip_inner),
        ] {
            let compressed = compress_fn(payload, 3).unwrap_or_else(|e| panic!("{name}: {e}"));
            let out = decompress_dynamic_inner(&compressed, 256 * 1024 * 1024, None)
                .unwrap_or_else(|e| panic!("{name} decompress: {e}"));
            assert_eq!(out, payload, "{name} roundtrip");
        }
    }

    #[test]
    fn empty_and_one_byte_roundtrip() {
        roundtrip_formats(b"");
        roundtrip_formats(b"a");
    }

    #[test]
    fn empty_xz_fixture_decompresses() {
        // Native `xz` empty archive (32 bytes).
        let empty_xz = hex_literal(
            "fd377a585a000004e6d6b446000000001cdf44211fb6f37d010000000004595a",
        );
        let out = decompress_dynamic_inner(&empty_xz, 256 * 1024 * 1024, None).unwrap();
        assert!(out.is_empty());
    }

    fn hex_literal(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn destination_too_small_errors() {
        let payload = b"hello world";
        let compressed = compress_xz_inner(payload, 1).unwrap();
        let mut buf = vec![0u8; payload.len() - 1];
        let err = decompress_to_buffer_inner(&compressed, &mut buf, 256 * 1024 * 1024).unwrap_err();
        assert!(err.contains("too small"), "{err}");
    }

    #[test]
    fn exact_and_larger_buffer_succeed() {
        let payload = b"hello world";
        let compressed = compress_xz_inner(payload, 1).unwrap();

        let mut exact = vec![0u8; payload.len()];
        let n = decompress_to_buffer_inner(&compressed, &mut exact, 256 * 1024 * 1024).unwrap();
        assert_eq!(n, payload.len());
        assert_eq!(&exact[..n], payload);

        let mut larger = vec![0u8; payload.len() + 16];
        let n = decompress_to_buffer_inner(&compressed, &mut larger, 256 * 1024 * 1024).unwrap();
        assert_eq!(n, payload.len());
        assert_eq!(&larger[..n], payload);
    }

    #[test]
    fn zero_length_buffer_only_for_empty() {
        let empty_xz = hex_literal(
            "fd377a585a000004e6d6b446000000001cdf44211fb6f37d010000000004595a",
        );
        let mut buf = [];
        assert_eq!(
            decompress_to_buffer_inner(&empty_xz, &mut buf, 256 * 1024 * 1024).unwrap(),
            0
        );

        let nonempty = compress_xz_inner(b"x", 1).unwrap();
        assert!(decompress_to_buffer_inner(&nonempty, &mut buf, 256 * 1024 * 1024).is_err());
    }

    #[test]
    fn max_output_size_enforced() {
        let payload = b"abcdefghijklmnopqrstuvwxyz";
        let compressed = compress_xz_inner(payload, 1).unwrap();

        let ok = decompress_dynamic_inner(&compressed, 256 * 1024 * 1024, Some(payload.len() as u32))
            .unwrap();
        assert_eq!(ok, payload);

        let err = decompress_dynamic_inner(
            &compressed,
            256 * 1024 * 1024,
            Some((payload.len() - 1) as u32),
        )
        .unwrap_err();
        assert!(err.contains("maxOutputSize"), "{err}");
    }

    #[test]
    fn lzip_magic_detected_when_truncated() {
        let truncated = b"LZIP";
        let err = decompress_dynamic_inner(truncated, 256 * 1024 * 1024, None).unwrap_err();
        assert!(
            err.contains("Truncated LZIP") || err.contains("LZIP"),
            "should route to LZIP path, got: {err}"
        );
        assert!(!err.contains("too short to identify"), "{err}");
    }

    #[test]
    fn format_detection_lengths_do_not_use_global_six_byte_gate() {
        for len in 0..=3 {
            let data = &b"LZIP"[..len];
            // Incomplete LZIP magic prefixes fall through to LZMA-Alone.
            let result = decompress_dynamic_inner(data, 256 * 1024 * 1024, None);
            assert!(
                result.is_err(),
                "length {len} should not successfully decode as LZIP"
            );
            if let Err(msg) = result {
                assert!(!msg.contains("too short to identify"), "{msg}");
            }
        }

        let four = b"LZIP";
        let err4 = decompress_dynamic_inner(four, 256 * 1024 * 1024, None).unwrap_err();
        assert!(!err4.contains("too short to identify"));
        assert!(err4.contains("Truncated LZIP"), "{err4}");

        let five = b"LZIP\x01";
        let err5 = decompress_dynamic_inner(five, 256 * 1024 * 1024, None).unwrap_err();
        assert!(!err5.contains("too short to identify"));
        assert!(err5.contains("Truncated LZIP"), "{err5}");
    }

    #[test]
    fn lzip_rejects_invalid_version_and_dict_byte() {
        for sample in [b"LZIP\x02\x0C".as_slice(), b"LZIP\x01\xFF", b"LZIP\xFF\xFF"] {
            let err = decompress_dynamic_inner(sample, 256 * 1024 * 1024, None).unwrap_err();
            assert!(
                err.contains("version")
                    || err.contains("dictionary")
                    || err.contains("Truncated")
                    || err.contains("Invalid LZIP")
                    || err.contains("member size"),
                "sample {:?} -> {err}",
                sample
            );
        }
    }

    #[test]
    fn lzip_rejects_trailing_malformed_member() {
        let good = compress_lzip_inner(b"abc", 1).unwrap();
        for trailing in [
            b"LZIP".as_slice(),
            b"LZIP\x01",
            b"LZIP\x01\xFF",
            b"LZIP\xFF\xFF",
            b"\x01\x02\x03\x04",
        ] {
            let mut combined = good.clone();
            combined.extend_from_slice(trailing);
            let err = decompress_dynamic_inner(&combined, 256 * 1024 * 1024, None).unwrap_err();
            assert!(
                err.contains("Trailing")
                    || err.contains("malformed")
                    || err.contains("Invalid LZIP")
                    || err.contains("member size")
                    || err.contains("version")
                    || err.contains("dictionary"),
                "trailing {:?} should fail, got: {err}",
                trailing
            );
        }
    }

    #[test]
    fn highly_repetitive_4mib_roundtrip() {
        let payload = vec![0xABu8; 4 * 1024 * 1024];
        let compressed = compress_xz_inner(&payload, 1).unwrap();
        assert!(compressed.len() < 64 * 1024, "expected high compression");
        let out = decompress_dynamic_inner(&compressed, 256 * 1024 * 1024, None).unwrap();
        assert_eq!(out.len(), payload.len());
        assert_eq!(out, payload);

        let capped = decompress_dynamic_inner(
            &compressed,
            256 * 1024 * 1024,
            Some((payload.len() as u32) - 1),
        );
        assert!(capped.is_err());
    }
}
