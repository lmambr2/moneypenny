from datarunner.ocr import detect_gpu


def test_detect_gpu_returns_known_label():
    assert detect_gpu() in {"cpu", "cuda", "rocm", "openvino"}
