from datarunner.parse import parse_ocr_text


def test_parse_two_column_prices():
    text = """
Local Market
Commodity          Buy     Sell
Agricium           4000    12000    80    40
Quantainium        11000   22000    10    8
"""
    rows = parse_ocr_text(text)
    names = [r["name"] for r in rows]
    assert "Agricium" in names
    assert "Quantainium" in names
    agri = next(r for r in rows if r["name"] == "Agricium")
    assert agri["price_buy"] == 4000
    assert agri["price_sell"] == 12000
