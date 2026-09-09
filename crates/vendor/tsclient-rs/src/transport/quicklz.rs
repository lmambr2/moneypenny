const TABLE_SIZE: usize = 4096;

struct QlzState {
    control: u32,
    source_pos: usize,
    dest_pos: usize,
    next_hashed: usize,
}

pub struct Qlz {
    hashtable: Box<[i32; TABLE_SIZE]>,
}

impl Qlz {
    pub fn new() -> Self {
        Self {
            hashtable: Box::new([0i32; TABLE_SIZE]),
        }
    }

    pub fn decompress(&mut self, data: &[u8]) -> Result<Vec<u8>, String> {
        let (header_len, decompressed_size, flags) = parse_qlz_header(data)?;

        let mut dest = vec![0u8; decompressed_size];

        if flags & 0x01 == 0 {
            // 与 JS `dest.set(data.slice(headerLen, headerLen + decompressedSize))` 对应：
            // slice 超出 data 长度时截断，set 只复制可用部分，剩余保持 0
            let src = &data[header_len..];
            let n = src.len().min(decompressed_size);
            dest[..n].copy_from_slice(&src[..n]);
            return Ok(dest);
        }

        self.hashtable.fill(0);

        let mut state = QlzState {
            control: 1,
            source_pos: header_len,
            dest_pos: 0,
            next_hashed: 0,
        };

        while self.ensure_control(data, &mut state) {
            if state.control & 1 != 0 {
                if !self.process_reference(data, &mut dest, &mut state) {
                    break;
                }
            } else {
                if self.process_literal(data, &mut dest, decompressed_size, &mut state) {
                    break;
                }
            }
        }

        Ok(dest)
    }

    fn ensure_control(&self, data: &[u8], st: &mut QlzState) -> bool {
        if st.control != 1 {
            return true;
        }
        if st.source_pos + 4 > data.len() {
            return false;
        }
        st.control = data[st.source_pos] as u32
            | (data[st.source_pos + 1] as u32) << 8
            | (data[st.source_pos + 2] as u32) << 16
            | (data[st.source_pos + 3] as u32) << 24;
        st.source_pos += 4;
        true
    }

    fn process_reference(&mut self, data: &[u8], dest: &mut [u8], st: &mut QlzState) -> bool {
        st.control >>= 1;
        if st.source_pos + 2 > data.len() {
            return false;
        }

        let b1 = data[st.source_pos];
        let b2 = data[st.source_pos + 1];
        st.source_pos += 2;

        let hash = (b1 as usize >> 4) | (b2 as usize) << 4;
        let mut matchlen = (b1 & 0x0f) as usize;
        if matchlen != 0 {
            matchlen += 2;
        } else {
            if st.source_pos >= data.len() {
                return false;
            }
            matchlen = data[st.source_pos] as usize;
            st.source_pos += 1;
        }

        let offset = self.hashtable[hash] as usize;
        for i in 0..matchlen {
            if st.dest_pos < dest.len() && offset + i < st.dest_pos {
                dest[st.dest_pos] = dest[offset + i];
                st.dest_pos += 1;
            }
        }

        let end = st.dest_pos + 1 - matchlen;
        self.update_hashtable(dest, st, end);
        st.next_hashed = st.dest_pos;

        true
    }

    fn process_literal(
        &mut self,
        data: &[u8],
        dest: &mut [u8],
        decompressed_size: usize,
        st: &mut QlzState,
    ) -> bool {
        let threshold = decompressed_size.max(10) - 10;
        if st.dest_pos >= threshold {
            while st.dest_pos < decompressed_size {
                if st.control == 1 {
                    st.source_pos += 4;
                    if st.source_pos > data.len() {
                        break;
                    }
                    st.control = data[st.source_pos - 4] as u32
                        | (data[st.source_pos - 3] as u32) << 8
                        | (data[st.source_pos - 2] as u32) << 16
                        | (data[st.source_pos - 1] as u32) << 24;
                }
                if st.source_pos >= data.len() {
                    break;
                }
                dest[st.dest_pos] = data[st.source_pos];
                st.dest_pos += 1;
                st.source_pos += 1;
                st.control >>= 1;
            }
            return true;
        }

        if st.source_pos >= data.len() || st.dest_pos >= dest.len() {
            return true;
        }

        dest[st.dest_pos] = data[st.source_pos];
        st.dest_pos += 1;
        st.source_pos += 1;
        st.control >>= 1;

        let end = (st.dest_pos as i64 - 2).max(0) as usize;
        self.update_hashtable(dest, st, end);
        if st.next_hashed < end {
            st.next_hashed = end;
        }

        false
    }

    fn update_hashtable(&mut self, dest: &[u8], st: &mut QlzState, end: usize) {
        while st.next_hashed < end {
            if st.next_hashed + 3 > dest.len() {
                break;
            }
            let v = dest[st.next_hashed] as u32
                | (dest[st.next_hashed + 1] as u32) << 8
                | (dest[st.next_hashed + 2] as u32) << 16;
            let hash = ((v >> 12) ^ v) & 0xfff;
            self.hashtable[hash as usize] = st.next_hashed as i32;
            st.next_hashed += 1;
        }
    }
}

fn parse_qlz_header(data: &[u8]) -> Result<(usize, usize, u8), String> {
    if data.len() < 3 {
        return Err("QuickLZ: data too short".to_string());
    }

    let flags = data[0];
    let level = (flags >> 2) & 0x03;
    if level != 1 {
        return Err("QuickLZ: only level 1 is supported".to_string());
    }

    let header_len = if flags & 0x02 != 0 { 9 } else { 3 };
    if data.len() < header_len {
        return Err("QuickLZ: data too short for header".to_string());
    }

    let decompressed_size = if flags & 0x02 != 0 {
        (data[5] as u32
            | (data[6] as u32) << 8
            | (data[7] as u32) << 16
            | (data[8] as u32) << 24) as usize
    } else {
        data[2] as usize
    };

    Ok((header_len, decompressed_size, flags))
}
