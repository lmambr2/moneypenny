// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

pub fn l2_normalize(vec: &[f32]) -> Vec<f32> {
    if vec.is_empty() {
        return Vec::new();
    }
    let sum: f32 = vec.iter().map(|x| x * x).sum();
    let n = sum.sqrt();
    if !(n > 1e-12) {
        return vec.to_vec();
    }
    vec.iter().map(|x| x / n).collect()
}

pub fn l2_normalize_batch(vectors: Vec<Vec<f32>>) -> Vec<Vec<f32>> {
    vectors.into_iter().map(|v| l2_normalize(&v)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unit_length() {
        let v = l2_normalize(&[3.0, 4.0]);
        let n: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((n - 1.0).abs() < 1e-5);
    }
}
