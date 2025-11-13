#!/usr/bin/env python
import sys
import json
import re
from typing import List, Tuple

def try_import_rapidocr():
    try:
        from rapidocr_onnxruntime import RapidOCR  # type: ignore
        return RapidOCR
    except Exception:
        return None

def ocr_with_rapidocr(img_path: str) -> List[str]:
    RapidOCR = try_import_rapidocr()
    if RapidOCR is None:
        return []
    try:
        engine = RapidOCR()
        result, _ = engine(img_path)
        lines = [r[1][0] for r in result] if result else []
        return lines
    except Exception:
        return []

def clean_text(lines: List[str]) -> List[str]:
    cleaned = []
    for ln in lines:
        t = ln.strip()
        if not t:
            continue
        # unify spaces
        t = re.sub(r"\s+", " ", t)
        cleaned.append(t)
    return cleaned

def detect_tipo(lines: List[str]) -> str:
    joined = " ".join(lines).lower()
    if "factura" in joined:
        return "factura"
    if "boleta" in joined or "ticket" in joined:
        return "boleta"
    return ""

def detect_fecha(lines: List[str]) -> str:
    patterns = [
        r"(20\d{2})[-/](0[1-9]|1[0-2])[-/](0[1-9]|[12]\d|3[01])",  # YYYY-MM-DD
        r"(0[1-9]|[12]\d|3[01])[-/](0[1-9]|1[0-2])[-/](20\d{2})",  # DD-MM-YYYY
    ]
    for ln in lines:
        for p in patterns:
            m = re.search(p, ln)
            if m:
                g = m.groups()
                if len(g) == 3 and len(g[0]) == 4:  # YYYY MM DD
                    return f"{g[0]}-{g[1]}-{g[2]}"
                # DD MM YYYY
                return f"{g[2]}-{g[1]}-{g[0]}"
    return ""

def normalize_amount(txt: str) -> str:
    # replace thousand separators and use dot as decimal
    t = txt.replace(" ", "")
    t = t.replace("S/", "").replace("US$", "").replace("$", "")
    t = t.replace(",", ".")
    m = re.findall(r"\d+\.?\d{0,2}", t)
    if not m:
        return ""
    try:
        amt = float(m[-1])
        return f"{amt:.2f}"
    except Exception:
        return ""

def detect_moneda(lines: List[str]) -> str:
    joined = " ".join(lines).upper()
    if "PEN" in joined or "S/" in joined:
        return "PEN"
    if "USD" in joined or "US$" in joined or "$" in joined:
        return "USD"
    return ""

def detect_total(lines: List[str]) -> str:
    # Prefer amount near TOTAL word; fallback to max amount seen
    max_amt = 0.0
    total_amt = ""
    for ln in lines:
        ln_up = ln.upper()
        numbers = re.findall(r"\d+[\.,]\d{2}", ln)
        if numbers:
            for n in numbers:
                try:
                    v = float(n.replace(",", "."))
                    if v > max_amt:
                        max_amt = v
                except Exception:
                    pass
        if "TOTAL" in ln_up:
            # try amount on this line
            if numbers:
                total_amt = normalize_amount(numbers[-1])
    if total_amt:
        return total_amt
    if max_amt > 0:
        return f"{max_amt:.2f}"
    return ""

def detect_ruc(lines: List[str]) -> str:
    for ln in lines:
        m = re.search(r"(RUC\s*[:#]?\s*)?(\d{11})", ln.upper())
        if m:
            return m.group(2)
    return ""

def detect_numero(lines: List[str]) -> str:
    for ln in lines:
        m = re.search(r"([FB][0-9]{3}-[0-9]{5,8})", ln.upper())
        if m:
            return m.group(1)
        m2 = re.search(r"([A-Z][0-9]{3}-[0-9]{5,10})", ln.upper())
        if m2:
            return m2.group(1)
    # fallback: series like 001-12345
    for ln in lines:
        m = re.search(r"([0-9]{3}-[0-9]{5,8})", ln)
        if m:
            return m.group(1)
    return ""

def detect_proveedor(lines: List[str]) -> str:
    # Heurística: primera línea en mayúsculas que parece nombre comercial
    for ln in lines[:8]:
        t = ln.strip()
        if len(t) < 3:
            continue
        if re.search(r"SAC|SA|SRL|EIRL|S\.A\.|S\.A\.C", t.upper()):
            return t
    # Otra heurística: línea cerca de RUC
    for i, ln in enumerate(lines):
        if "RUC" in ln.upper() and i > 0:
            prev = lines[i-1].strip()
            if len(prev) > 3:
                return prev
    return ""

def detect_categoria(lines: List[str]) -> str:
    joined = " ".join(lines).lower()
    if any(k in joined for k in ["rest", "pollo", "pizza", "sandwich", "bembos", "kfc", "comida", "market", "super"]):
        return "alimentación"
    if any(k in joined for k in ["uber", "taxi", "bus", "peaje", "gasolina", "shell", "grif"]):
        return "transporte"
    if any(k in joined for k in ["luz", "agua", "internet", "claro", "movistar", "servicio"]):
        return "servicios"
    if any(k in joined for k in ["cine", "netflix", "spotify", "pub", "bar"]):
        return "entretenimiento"
    if any(k in joined for k in ["colegio", "universidad", "curso", "libro"]):
        return "educación"
    if any(k in joined for k in ["farmacia", "clinica", "salud", "medic"]):
        return "salud"
    if any(k in joined for k in ["alquiler", "inmobiliaria", "hogar", "vivienda"]):
        return "vivienda"
    if any(k in joined for k in ["laptop", "pc", "celular", "iphone", "samsung", "tecnolog"]):
        return "tecnología"
    return ""

def main():
    if len(sys.argv) < 2:
        print(json.dumps({
            "tipo_documento": "",
            "proveedor": "",
            "ruc_proveedor": "",
            "fecha_emision": "",
            "monto_total": "",
            "moneda": "",
            "categoria_gasto": "",
            "numero_documento": "",
            "items": [],
            "observaciones": "",
            "text": ""
        }))
        sys.exit(0)
    img_path = sys.argv[1]
    lines = ocr_with_rapidocr(img_path)
    lines = clean_text(lines)
    joined = " \n ".join(lines)
    result = {
        "tipo_documento": detect_tipo(lines),
        "proveedor": detect_proveedor(lines),
        "ruc_proveedor": detect_ruc(lines),
        "fecha_emision": detect_fecha(lines),
        "monto_total": detect_total(lines),
        "moneda": detect_moneda(lines),
        "categoria_gasto": detect_categoria(lines),
        "numero_documento": detect_numero(lines),
        "items": [],
        "observaciones": "",
        "text": joined,
    }
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0)

if __name__ == "__main__":
    main()