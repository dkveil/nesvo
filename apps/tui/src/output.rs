use std::{
    cell::Cell,
    io::{self, Write},
    rc::Rc,
};

pub struct FrameWriter<W> {
    writer: W,
    pending: Vec<u8>,
    batching: Rc<Cell<bool>>,
}

impl<W: Write> FrameWriter<W> {
    pub fn new(writer: W, batching: Rc<Cell<bool>>) -> Self {
        Self {
            writer,
            pending: Vec::with_capacity(64 * 1024),
            batching,
        }
    }
}

impl<W: Write> Write for FrameWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.pending.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        if self.batching.get() {
            return Ok(());
        }
        if !self.pending.is_empty() {
            self.writer.write_all(&self.pending)?;
            self.pending.clear();
        }
        self.writer.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct CountingWriter {
        bytes: Vec<u8>,
        writes: usize,
    }
    impl Write for CountingWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.writes += 1;
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn text_and_cursor_flushes_commit_as_one_ordered_write() {
        let batching = Rc::new(Cell::new(true));
        let mut output = FrameWriter::new(CountingWriter::default(), batching.clone());
        output.write_all(b"text").unwrap();
        output.flush().unwrap();
        output.write_all(b"\x1b[?25h").unwrap();
        output.flush().unwrap();
        output.write_all(b"\x1b[3;4H").unwrap();
        output.flush().unwrap();
        assert_eq!(output.writer.writes, 0);
        batching.set(false);
        output.flush().unwrap();
        assert_eq!(output.writer.writes, 1);
        assert_eq!(output.writer.bytes, b"text\x1b[?25h\x1b[3;4H");
        output.flush().unwrap();
        assert_eq!(output.writer.writes, 1);
    }
}
