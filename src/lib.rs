use wasm_bindgen::prelude::*;
use lzma_rust2::{LzmaReader, XzReader, LzipReader};
use std::io::Read;

enum AutoReader<'a> {
    Lzma(LzmaReader<&'a [u8]>),
    Xz(XzReader<&'a [u8]>),
    Lzip(LzipReader<&'a [u8]>),
}

impl<'a> Read for AutoReader<'a> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            AutoReader::Lzma(r) => r.read(buf),
            AutoReader::Xz(r) => r.read(buf),
            AutoReader::Lzip(r) => r.read(buf),
        }
    }
}

#[wasm_bindgen]
pub fn decode_lzma_to_buffer(compressed: &[u8], out_buffer: &mut [u8]) -> Result<usize, JsValue> {
    if compressed.len() < 6 {
        return Err(JsValue::from_str("输入的数据太短，无法识别格式"));
    }

    // 探针检测
    let is_xz = compressed.starts_with(&[0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00]);
    let is_lzip = compressed.starts_with(&[0x4C, 0x5A, 0x49, 0x50]); // b"LZIP"

    // 路由分发
    let mut reader = if is_xz {
        let r = XzReader::new(compressed, true);
            // .map_err(|e| JsValue::from_str(&format!("初始化 XzReader 失败: {}", e)))?;
        AutoReader::Xz(r)
    } else if is_lzip {
        let r = LzipReader::new(compressed);
            // .map_err(|e| JsValue::from_str(&format!("初始化 LzipReader 失败: {}", e)))?;
        AutoReader::Lzip(r)
    } else {
        // Fallback 到传统的 LZMA Alone
        let r = LzmaReader::new_mem_limit(compressed, u32::MAX, None)
            .map_err(|e| JsValue::from_str(&format!("初始化 LzmaReader 失败: {}", e)))?;
        AutoReader::Lzma(r)
    };

    let mut total_read = 0;
    let out_len = out_buffer.len();

    loop {
        if total_read >= out_len {
            break;
        }

        let n = reader
            .read(&mut out_buffer[total_read..])
            .map_err(|e| JsValue::from_str(&format!("解压读取失败: {}", e)))?;

        if n == 0 {
            break;
        }
        total_read += n;
    }

    Ok(total_read)
}