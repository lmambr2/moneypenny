pub fn parse_u64(s: &str) -> u64 {
    if s.is_empty() {
        return 0;
    }
    s.parse::<u64>().unwrap_or(0)
}

pub fn parse_u16(s: &str) -> i32 {
    let v: i32 = s.parse().unwrap_or(0);
    if v < 0 || v > 65535 {
        return 0;
    }
    v
}

pub fn parse_i10(s: &str) -> i32 {
    s.parse().unwrap_or(0)
}

pub fn is_auto_nickname_match(expected: &str, actual: &str) -> bool {
    if actual == expected {
        return true;
    }
    if !actual.starts_with(expected) {
        return false;
    }
    // Use .get() for char-safe slicing — avoids panic if expected.len()
    // falls on a non-char boundary (defensive; starts_with guarantees validity).
    let suffix = actual.get(expected.len()..).unwrap_or("");
    suffix.chars().all(|c| c.is_ascii_digit()) && !suffix.is_empty()
}

pub fn split_command_rows(line: &str) -> Vec<String> {
    let space_idx = match line.find(' ') {
        Some(i) => i,
        None => return vec![line.to_string()],
    };

    let name = &line[..space_idx];
    let rest = &line[space_idx + 1..];

    if !rest.contains('|') {
        return vec![line.to_string()];
    }

    let parts: Vec<&str> = rest.split('|').collect();
    let rows: Vec<String> = parts
        .iter()
        .filter(|p| !p.is_empty())
        .map(|p| format!("{} {}", name, p))
        .collect();

    if rows.is_empty() {
        vec![line.to_string()]
    } else {
        rows
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_u64() {
        assert_eq!(parse_u64(""), 0);
        assert_eq!(parse_u64("42"), 42);
        assert_eq!(parse_u64("0"), 0);
    }

    #[test]
    fn test_parse_u16() {
        assert_eq!(parse_u16("0"), 0);
        assert_eq!(parse_u16("65535"), 65535);
        assert_eq!(parse_u16("65536"), 0);
        assert_eq!(parse_u16("-1"), 0);
    }

    #[test]
    fn test_parse_i10() {
        assert_eq!(parse_i10("42"), 42);
        assert_eq!(parse_i10("0"), 0);
        assert_eq!(parse_i10("-1"), -1);
        assert_eq!(parse_i10("abc"), 0);
    }

    #[test]
    fn test_is_auto_nickname_match() {
        assert!(is_auto_nickname_match("user", "user"));
        assert!(is_auto_nickname_match("user", "user1"));
        assert!(is_auto_nickname_match("user", "user42"));
        assert!(!is_auto_nickname_match("user", "usera"));
        assert!(!is_auto_nickname_match("user", "other"));
    }

    #[test]
    fn test_split_command_rows() {
        let result = split_command_rows("cmd1 arg1|arg2|arg3");
        assert_eq!(result.len(), 3);
        assert_eq!(result[0], "cmd1 arg1");
        assert_eq!(result[1], "cmd1 arg2");
        assert_eq!(result[2], "cmd1 arg3");
    }

    #[test]
    fn test_split_command_rows_no_pipe() {
        let result = split_command_rows("cmd1 arg1 arg2");
        assert_eq!(result.len(), 1);
        assert_eq!(result[0], "cmd1 arg1 arg2");
    }

    #[test]
    fn test_split_command_rows_no_args() {
        let result = split_command_rows("cmd1");
        assert_eq!(result.len(), 1);
        assert_eq!(result[0], "cmd1");
    }
}
