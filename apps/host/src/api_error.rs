use std::fmt;
#[derive(Debug)]
pub struct Error {
    pub code: &'static str,
    message: &'static str,
}
impl Error {
    pub fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message)
    }
}
impl std::error::Error for Error {}
