use crate::parse::PriceRow;

pub fn format_table(prices: &[PriceRow]) -> String {
    if prices.is_empty() {
        return "(no rows parsed)".into();
    }
    let mut lines = vec![format!(
        "{:<24} {:>10} {:>10} {:>8} {:>8}",
        "name", "buy", "sell", "scu_b", "scu_s"
    )];
    lines.push("-".repeat(64));
    for p in prices {
        lines.push(format!(
            "{:<24} {:>10} {:>10} {:>8} {:>8}",
            p.name,
            fmt(p.price_buy),
            fmt(p.price_sell),
            fmt_i(p.scu_buy),
            fmt_i(p.scu_sell),
        ));
    }
    lines.join("\n")
}

fn fmt(v: Option<f64>) -> String {
    match v {
        None => "-".into(),
        Some(n) if n.fract() == 0.0 => format!("{}", n as i64),
        Some(n) => format!("{n}"),
    }
}

fn fmt_i(v: Option<i64>) -> String {
    v.map(|n| n.to_string()).unwrap_or_else(|| "-".into())
}

pub fn confirm(prompt: &str, yes: bool) -> bool {
    if yes {
        return true;
    }
    eprint!("{prompt} [y/N] ");
    let mut buf = String::new();
    if std::io::stdin().read_line(&mut buf).is_err() {
        return false;
    }
    matches!(buf.trim().to_ascii_lowercase().as_str(), "y" | "yes")
}
