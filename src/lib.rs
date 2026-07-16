use lzma_rust2::{
    LzipOptions, LzipReader, LzipWriter, LzmaOptions, LzmaReader, LzmaWriter, XzOptions, XzReader,
    XzWriter,
};
use std::collections::VecDeque;
use std::io::{ErrorKind, Read, Write};
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

enum XzGateState {
    StreamHeader,
    BlockHeader {
        check_size: usize,
    },
    BlockData {
        check_size: usize,
        data_size: usize,
        output_size: usize,
        stream_chunks: bool,
    },
    StreamPadding,
}

struct XzInputGate {
    pending: Vec<u8>,
    pending_offset: usize,
    held_stream_end: Vec<u8>,
    held_block: Vec<u8>,
    state: XzGateState,
}

struct XzGateOutput {
    input: Vec<u8>,
    output_sizes: Vec<usize>,
}

impl XzInputGate {
    fn new() -> Self {
        Self {
            pending: Vec::new(),
            pending_offset: 0,
            held_stream_end: Vec::new(),
            held_block: Vec::new(),
            state: XzGateState::StreamHeader,
        }
    }

    fn take(&mut self, count: usize, ready: &mut Vec<u8>) {
        let end = self.pending_offset + count;
        ready.extend_from_slice(&self.pending[self.pending_offset..end]);
        self.pending_offset = end;
    }

    fn hold(&mut self, count: usize) {
        let end = self.pending_offset + count;
        self.held_stream_end
            .extend_from_slice(&self.pending[self.pending_offset..end]);
        self.pending_offset = end;
    }

    fn hold_block(&mut self, count: usize) {
        let end = self.pending_offset + count;
        self.held_block
            .extend_from_slice(&self.pending[self.pending_offset..end]);
        self.pending_offset = end;
    }

    fn available(&self) -> &[u8] {
        &self.pending[self.pending_offset..]
    }

    fn feed(&mut self, input: &[u8], ending: bool) -> Result<XzGateOutput, String> {
        if self.pending_offset == self.pending.len() {
            self.pending.clear();
            self.pending_offset = 0;
        } else if self.pending_offset >= READ_CHUNK {
            self.pending.drain(..self.pending_offset);
            self.pending_offset = 0;
        }
        self.pending.extend_from_slice(input);
        let mut ready = Vec::new();
        let mut output_sizes = Vec::new();

        loop {
            match self.state {
                XzGateState::StreamHeader => {
                    let pending = self.available();
                    if pending.len() < 12 {
                        break;
                    }
                    let check_size = xz_check_size(&pending[..12])?;
                    self.take(12, &mut ready);
                    self.state = XzGateState::BlockHeader { check_size };
                }
                XzGateState::BlockHeader { check_size } => {
                    let pending = self.available();
                    let Some(&header_size_byte) = pending.first() else {
                        break;
                    };
                    if header_size_byte == 0 {
                        let Some(index_size) = xz_index_size(pending)? else {
                            break;
                        };
                        self.hold(index_size);
                        self.state = XzGateState::StreamPadding;
                    } else {
                        let header_size = (header_size_byte as usize + 1) * 4;
                        if !(8..=1024).contains(&header_size) {
                            return Err("Invalid XZ block header size".to_string());
                        }
                        if pending.len() < header_size {
                            break;
                        }
                        let stream_chunks = (pending[1] & 0x03) == 0;
                        self.take(header_size, &mut ready);
                        self.state = XzGateState::BlockData {
                            check_size,
                            data_size: 0,
                            output_size: 0,
                            stream_chunks,
                        };
                    }
                }
                XzGateState::BlockData {
                    check_size,
                    data_size,
                    output_size,
                    stream_chunks,
                } => {
                    let pending = self.available();
                    let Some(unit) = lzma2_unit(pending)? else {
                        break;
                    };
                    match unit {
                        Lzma2Unit::Data {
                            input_size,
                            output_size: unit_output_size,
                        } => {
                            if stream_chunks {
                                self.take(input_size, &mut ready);
                                output_sizes.push(unit_output_size);
                            } else {
                                self.hold_block(input_size);
                            }
                            self.state = XzGateState::BlockData {
                                check_size,
                                data_size: data_size.checked_add(input_size).ok_or_else(|| {
                                    "XZ block compressed size is too large".to_string()
                                })?,
                                output_size: output_size.checked_add(unit_output_size).ok_or_else(
                                    || "XZ block output size is too large".to_string(),
                                )?,
                                stream_chunks,
                            };
                        }
                        Lzma2Unit::End => {
                            let final_data_size = data_size.checked_add(1).ok_or_else(|| {
                                "XZ block compressed size is too large".to_string()
                            })?;
                            let padding = (4 - (final_data_size % 4)) % 4;
                            let tail_size = 1usize
                                .checked_add(padding)
                                .and_then(|size| size.checked_add(check_size))
                                .ok_or_else(|| "XZ block tail is too large".to_string())?;
                            if pending.len() < tail_size {
                                break;
                            }
                            if stream_chunks {
                                self.take(tail_size, &mut ready);
                            } else {
                                self.hold_block(tail_size);
                                ready.append(&mut self.held_block);
                                if output_size > 0 {
                                    output_sizes.push(output_size);
                                }
                            }
                            self.state = XzGateState::BlockHeader { check_size };
                        }
                    }
                }
                XzGateState::StreamPadding => {
                    let pending = self.available();
                    let padding = pending
                        .iter()
                        .position(|&byte| byte != 0)
                        .unwrap_or(pending.len());
                    if padding == pending.len() {
                        if ending {
                            if padding % 4 != 0 {
                                return Err(
                                    "XZ stream padding size is not a multiple of 4".to_string()
                                );
                            }
                            ready.append(&mut self.held_stream_end);
                            self.take(padding, &mut ready);
                        }
                        break;
                    }
                    if padding % 4 != 0 {
                        return Err("XZ stream padding size is not a multiple of 4".to_string());
                    }
                    if pending.len() < padding + 12 {
                        break;
                    }
                    let check_size = xz_check_size(&pending[padding..padding + 12])?;
                    ready.append(&mut self.held_stream_end);
                    self.take(padding + 12, &mut ready);
                    self.state = XzGateState::BlockHeader { check_size };
                }
            }
        }

        if ending && !matches!(self.state, XzGateState::StreamPadding) {
            return Err("Truncated XZ stream".to_string());
        }
        if ending && !self.available().is_empty() {
            return Err("Trailing or incomplete XZ data".to_string());
        }
        if ending && !self.held_stream_end.is_empty() {
            return Err("Incomplete XZ stream finalization".to_string());
        }
        if ending && !self.held_block.is_empty() {
            return Err("Incomplete XZ block".to_string());
        }
        Ok(XzGateOutput {
            input: ready,
            output_sizes,
        })
    }
}

enum Lzma2Unit {
    Data {
        input_size: usize,
        output_size: usize,
    },
    End,
}

fn lzma2_unit(input: &[u8]) -> Result<Option<Lzma2Unit>, String> {
    let Some(&control) = input.first() else {
        return Ok(None);
    };
    if control == 0 {
        return Ok(Some(Lzma2Unit::End));
    }

    let (input_size, output_size) = if control == 1 || control == 2 {
        if input.len() < 3 {
            return Ok(None);
        }
        let output_size = u16::from_be_bytes([input[1], input[2]]) as usize + 1;
        let input_size = 3usize
            .checked_add(output_size)
            .ok_or_else(|| "LZMA2 chunk size is too large".to_string())?;
        (input_size, output_size)
    } else if control >= 0x80 {
        let header_size = if control >= 0xC0 { 6 } else { 5 };
        if input.len() < header_size {
            return Ok(None);
        }
        let output_size =
            (((control & 0x1F) as usize) << 16) | ((input[1] as usize) << 8) | input[2] as usize;
        let input_size = header_size
            .checked_add(u16::from_be_bytes([input[3], input[4]]) as usize + 1)
            .ok_or_else(|| "LZMA2 chunk size is too large".to_string())?;
        (input_size, output_size + 1)
    } else {
        return Err("Invalid LZMA2 control byte".to_string());
    };

    if input.len() < input_size {
        Ok(None)
    } else {
        Ok(Some(Lzma2Unit::Data {
            input_size,
            output_size,
        }))
    }
}

fn xz_check_size(header: &[u8]) -> Result<usize, String> {
    if header.len() < 12 || !header.starts_with(XZ_MAGIC) {
        return Err("Invalid XZ stream header".to_string());
    }
    match header[7] {
        0x00 => Ok(0),
        0x01 => Ok(4),
        0x04 => Ok(8),
        0x0A => Ok(32),
        _ => Err("Unsupported XZ integrity check".to_string()),
    }
}

fn xz_vli(input: &[u8], offset: &mut usize) -> Result<Option<u64>, String> {
    let mut value = 0u64;
    for index in 0..9 {
        let Some(&byte) = input.get(*offset) else {
            return Ok(None);
        };
        *offset += 1;
        value |= ((byte & 0x7F) as u64) << (index * 7);
        if byte & 0x80 == 0 {
            return Ok(Some(value));
        }
    }
    Err("Invalid XZ variable-length integer".to_string())
}

fn xz_index_size(input: &[u8]) -> Result<Option<usize>, String> {
    if input.first() != Some(&0) {
        return Err("Invalid XZ index indicator".to_string());
    }
    let mut offset = 1;
    let Some(record_count) = xz_vli(input, &mut offset)? else {
        return Ok(None);
    };
    let record_count =
        usize::try_from(record_count).map_err(|_| "XZ index has too many records".to_string())?;
    if record_count > input.len() / 2 {
        return Ok(None);
    }
    for _ in 0..record_count {
        if xz_vli(input, &mut offset)?.is_none() || xz_vli(input, &mut offset)?.is_none() {
            return Ok(None);
        }
    }
    let padding = (4 - (offset % 4)) % 4;
    let total = offset
        .checked_add(padding)
        .and_then(|size| size.checked_add(4 + 12))
        .ok_or_else(|| "XZ index is too large".to_string())?;
    if input.len() < total {
        Ok(None)
    } else {
        Ok(Some(total))
    }
}

struct AppendableReader {
    input: Vec<u8>,
    offset: usize,
    ended: bool,
}

impl AppendableReader {
    fn new() -> Self {
        Self {
            input: Vec::new(),
            offset: 0,
            ended: false,
        }
    }

    fn append(&mut self, input: &[u8]) {
        if self.offset == self.input.len() {
            self.input.clear();
            self.offset = 0;
        } else if self.offset >= READ_CHUNK {
            self.input.drain(..self.offset);
            self.offset = 0;
        }
        self.input.extend_from_slice(input);
    }

    fn end(&mut self) {
        self.ended = true;
    }
}

impl Read for AppendableReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let available = self.input.len().saturating_sub(self.offset);
        if available == 0 {
            return if self.ended {
                Ok(0)
            } else {
                Err(std::io::Error::from(ErrorKind::WouldBlock))
            };
        }
        let count = available.min(buf.len());
        buf[..count].copy_from_slice(&self.input[self.offset..self.offset + count]);
        self.offset += count;
        Ok(count)
    }
}

struct XzStreamDecoderInner {
    reader: XzReader<AppendableReader>,
    gate: XzInputGate,
    output_sizes: VecDeque<usize>,
    finished: bool,
    failed: bool,
    total_output: usize,
    max_output_size: Option<usize>,
}

impl XzStreamDecoderInner {
    fn new(max_output_size: Option<u32>) -> Self {
        Self {
            reader: XzReader::new(AppendableReader::new(), true),
            gate: XzInputGate::new(),
            output_sizes: VecDeque::new(),
            finished: false,
            failed: false,
            total_output: 0,
            max_output_size: max_output_size.map(|value| value as usize),
        }
    }

    fn drain(&mut self) -> Result<Vec<u8>, String> {
        if self.failed {
            return Err("XZ decoder cannot be reused after an error".to_string());
        }
        if self.finished {
            return Err("XZ decoder has already finished".to_string());
        }

        let mut output = Vec::new();
        while let Some(&remaining) = self.output_sizes.front() {
            let requested = remaining.min(READ_CHUNK);
            let mut chunk = vec![0u8; requested];
            match self.reader.read(&mut chunk) {
                Ok(0) => {
                    self.failed = true;
                    return Err("XZ stream ended before producing the expected output".to_string());
                }
                Ok(count) => {
                    if let Some(limit) = self.max_output_size {
                        if self.total_output.saturating_add(count) > limit {
                            self.failed = true;
                            return Err("Decompressed output exceeds maxOutputSize".to_string());
                        }
                    }
                    self.total_output += count;
                    output.extend_from_slice(&chunk[..count]);
                    if count == remaining {
                        self.output_sizes.pop_front();
                    } else if let Some(front) = self.output_sizes.front_mut() {
                        *front -= count;
                    }
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    self.failed = true;
                    return Err(
                        "XZ decoder requested more input inside a complete LZMA2 chunk".to_string(),
                    );
                }
                Err(error) => {
                    self.failed = true;
                    return Err(format!("XZ streaming decompression failed: {error}"));
                }
            }
        }

        let mut probe = [0u8; 1];
        match self.reader.read(&mut probe) {
            Ok(0) => self.finished = true,
            Ok(_) => {
                self.failed = true;
                return Err("XZ decoder produced output outside a declared LZMA2 chunk".to_string());
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => {}
            Err(error) => {
                self.failed = true;
                return Err(format!("XZ streaming decompression failed: {error}"));
            }
        }
        Ok(output)
    }

    fn write(&mut self, input: &[u8]) -> Result<Vec<u8>, String> {
        if self.finished || self.failed {
            return self.drain();
        }
        let ready = match self.gate.feed(input, false) {
            Ok(ready) => ready,
            Err(error) => {
                self.failed = true;
                return Err(error);
            }
        };
        self.reader.inner_mut().append(&ready.input);
        self.output_sizes.extend(ready.output_sizes);
        self.drain()
    }

    fn finish(&mut self) -> Result<Vec<u8>, String> {
        if self.finished || self.failed {
            return self.drain();
        }
        let ready = match self.gate.feed(&[], true) {
            Ok(ready) => ready,
            Err(error) => {
                self.failed = true;
                return Err(error);
            }
        };
        self.reader.inner_mut().append(&ready.input);
        self.output_sizes.extend(ready.output_sizes);
        self.reader.inner_mut().end();
        let output = self.drain()?;
        if !self.finished {
            self.failed = true;
            return Err("Truncated XZ stream".to_string());
        }
        Ok(output)
    }
}

#[wasm_bindgen]
pub struct XzStreamDecoder {
    inner: XzStreamDecoderInner,
}

#[wasm_bindgen]
impl XzStreamDecoder {
    #[wasm_bindgen(constructor)]
    pub fn new(max_output_size: Option<u32>) -> Self {
        Self {
            inner: XzStreamDecoderInner::new(max_output_size),
        }
    }

    pub fn write(&mut self, input: &[u8]) -> Result<Vec<u8>, JsValue> {
        self.inner.write(input).map_err(to_js_err)
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, JsValue> {
        self.inner.finish().map_err(to_js_err)
    }
}

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

fn read_into_buffer<R: Read>(reader: &mut R, out_buffer: &mut [u8]) -> Result<usize, String> {
    let mut total_read = 0usize;
    let out_len = out_buffer.len();

    loop {
        if total_read >= out_len {
            let mut probe = [0u8; 1];
            let n = reader
                .read(&mut probe)
                .map_err(|e| format!("Decompression read failed: {e}"))?;
            if n > 0 {
                return Err("Destination buffer is too small for decompressed output".to_string());
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

fn read_dynamic<R: Read>(reader: &mut R, max_output_size: Option<u32>) -> Result<Vec<u8>, String> {
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
            (
                "xz",
                compress_xz_inner as fn(&[u8], u32) -> Result<Vec<u8>, String>,
            ),
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
        let empty_xz =
            hex_literal("fd377a585a000004e6d6b446000000001cdf44211fb6f37d010000000004595a");
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
        let empty_xz =
            hex_literal("fd377a585a000004e6d6b446000000001cdf44211fb6f37d010000000004595a");
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

        let ok =
            decompress_dynamic_inner(&compressed, 256 * 1024 * 1024, Some(payload.len() as u32))
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

    fn stream_decode(compressed: &[u8], chunk_size: usize) -> Result<Vec<u8>, String> {
        let mut decoder = XzStreamDecoderInner::new(None);
        let mut output = Vec::new();
        for chunk in compressed.chunks(chunk_size) {
            output.extend(decoder.write(chunk)?);
        }
        output.extend(decoder.finish()?);
        Ok(output)
    }

    #[test]
    fn xz_stream_decoder_accepts_arbitrary_chunk_boundaries() {
        let payload: Vec<u8> = (0..200_000).map(|index| (index % 251) as u8).collect();
        let compressed = compress_xz_inner(&payload, 3).unwrap();
        for chunk_size in [1, 2, 3, 5, 7, 11, 64, 1024, 65536] {
            let output = stream_decode(&compressed, chunk_size)
                .unwrap_or_else(|error| panic!("chunk size {chunk_size}: {error}"));
            assert_eq!(output, payload, "chunk size {chunk_size}");
        }
    }

    #[test]
    fn xz_stream_decoder_emits_before_finish() {
        let payload: Vec<u8> = (0..4_000_000).map(|index| (index % 239) as u8).collect();
        let compressed = compress_xz_inner(&payload, 1).unwrap();
        let mut decoder = XzStreamDecoderInner::new(None);
        let mut emitted = 0usize;
        for (index, chunk) in compressed.chunks(17).enumerate() {
            emitted += decoder.write(chunk).unwrap().len();
            if index + 1 < compressed.len().div_ceil(17) && emitted > 0 {
                break;
            }
        }
        assert!(emitted > 0, "decoder should emit output before finish");
    }

    #[test]
    fn xz_stream_decoder_accepts_concatenated_streams() {
        let first = compress_xz_inner(b"first member", 1).unwrap();
        let second = compress_xz_inner(b"second member", 1).unwrap();
        let combined = [first, second].concat();
        assert_eq!(
            stream_decode(&combined, 3).unwrap(),
            b"first membersecond member"
        );
    }

    #[test]
    fn xz_stream_decoder_accepts_empty_and_multi_block_streams() {
        let empty = compress_xz_inner(&[], 1).unwrap();
        assert!(stream_decode(&empty, 1).unwrap().is_empty());

        let payload: Vec<u8> = (0..500_000).map(|index| (index % 251) as u8).collect();
        let mut options = XzOptions::default();
        options.lzma_options.set_preset(1);
        options.set_block_size(std::num::NonZeroU64::new(64 * 1024));
        let mut writer = XzWriter::new(Vec::new(), options).unwrap();
        writer.write_all(&payload).unwrap();
        let compressed = writer.finish().unwrap();

        assert_eq!(stream_decode(&compressed, 1).unwrap(), payload);
    }

    #[test]
    fn xz_stream_decoder_accepts_prefiltered_streams() {
        let payload: Vec<u8> = (0..300_003).map(|index| (index % 193) as u8).collect();
        let mut options = XzOptions::default();
        options.lzma_options.set_preset(1);
        options.prepend_pre_filter(lzma_rust2::FilterType::BcjX86, 0);
        let mut writer = XzWriter::new(Vec::new(), options).unwrap();
        writer.write_all(&payload).unwrap();
        let compressed = writer.finish().unwrap();

        assert_eq!(stream_decode(&compressed, 3).unwrap(), payload);
    }

    #[test]
    fn xz_stream_decoder_rejects_truncated_input_and_output_over_limit() {
        let compressed = compress_xz_inner(b"streaming payload", 1).unwrap();
        assert!(stream_decode(&compressed[..compressed.len() - 1], 5).is_err());

        let mut decoder = XzStreamDecoderInner::new(Some(3));
        let mut result = Ok(Vec::new());
        for chunk in compressed.chunks(4) {
            result = decoder.write(chunk);
            if result.is_err() {
                break;
            }
        }
        if result.is_ok() {
            result = decoder.finish();
        }
        assert!(result.unwrap_err().contains("maxOutputSize"));
    }
}
