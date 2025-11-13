#!/usr/bin/env python
import sys
import json
import base64
import os

try:
    from openai import OpenAI
except Exception as e:
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
        "error": f"openai import failed: {e}"
    }))
    sys.exit(0)

PROMPT = (
    "Eres una IA experta en análisis de documentos financieros, especializada en facturas y boletas de venta.\n"
    "Recibirás una imagen o texto extraído de una factura o boleta, y tu tarea es identificar y estructurar la información clave de manera precisa y estandarizada.\n\n"
    "Debes analizar cuidadosamente el documento y devolver únicamente un JSON válido, con los siguientes campos:\n"
    "{\n"
    "  \"tipo_documento\": \"factura o boleta\",\n"
    "  \"proveedor\": \"nombre del comercio o empresa emisora\",\n"
    "  \"ruc_proveedor\": \"RUC o número de identificación del proveedor (si existe)\",\n"
    "  \"fecha_emision\": \"YYYY-MM-DD\",\n"
    "  \"monto_total\": \"monto total del documento\",\n"
    "  \"moneda\": \"PEN, USD, etc.\",\n"
    "  \"categoria_gasto\": \"categoría del gasto detectada o nueva\",\n"
    "  \"numero_documento\": \"número o serie del documento\",\n"
    "  \"items\": [\n"
    "    {\n"
    "      \"descripcion\": \"nombre del producto o servicio\",\n"
    "      \"cantidad\": \"cantidad comprada\",\n"
    "      \"precio_unitario\": \"precio por unidad\",\n"
    "      \"subtotal\": \"subtotal del ítem\"\n"
    "    }\n"
    "  ],\n"
    "  \"observaciones\": \"comentarios o detalles adicionales relevantes\"\n"
    "}\n\n"
    "Reglas de extracción:\n"
    "- Si un dato no aparece en el documento, deja su valor vacío (\"\").\n"
    "- Detecta automáticamente si el documento es factura o boleta.\n"
    "- Usa formato ISO 8601 para las fechas (YYYY-MM-DD).\n"
    "- Redondea los montos a dos decimales.\n"
    "- Si hay varios ítems, incluye todos en la lista \"items\".\n"
    "- No incluyas texto, explicaciones o comentarios fuera del JSON.\n"
    "- Los montos deben usar punto como separador decimal. Si el documento usa coma decimal (1.234,56), conviértelo a 1234.56.\n"
    "- Identifica la moneda: 'PEN' (símbolo 'S/') o 'USD' (símbolo '$'). Si no está explícito, asume 'PEN'.\n\n"
    "Categorías base:\n"
    "- alimentación, transporte, servicios, entretenimiento, educación, salud, vivienda, tecnología, otros.\n"
    "- Si el gasto pertenece a una categoría nueva, identifícala con un nombre claro y coherente (por ejemplo: \"ropa\", \"mascotas\", \"viajes\") y asigna ese valor en \"categoria_gasto\".\n\n"
    "Instrucción final:\n"
    "Devuelve solo el JSON final sin texto adicional, encabezados ni explicaciones."
)

SCHEMA = {
    "type": "object",
    "properties": {
        "tipo_documento": {"type": "string", "enum": ["factura", "boleta", "FACTURA", "BOLETA"]},
        "proveedor": {"type": "string"},
        "ruc_proveedor": {"anyOf": [{"type": "string"}, {"type": "null"}]},
        "fecha_emision": {"type": "string"},
        "monto_total": {"anyOf": [{"type": "number"}, {"type": "string"}]},
        "moneda": {"type": "string"},
        "categoria_gasto": {"anyOf": [{"type": "string"}, {"type": "null"}]},
        "numero_documento": {"anyOf": [{"type": "string"}, {"type": "null"}]},
        "items": {
            "anyOf": [
                {"type": "array", "items": {"type": "object", "properties": {"descripcion": {"type": "string"}, "cantidad": {"anyOf": [{"type": "number"}, {"type": "string"}]}, "precio_unitario": {"anyOf": [{"type": "number"}, {"type": "string"}]}, "subtotal": {"anyOf": [{"type": "number"}, {"type": "string"}]}} , "required": ["descripcion","cantidad","precio_unitario","subtotal"], "additionalProperties": False}},
                {"type": "null"}
            ]
        },
        "observaciones": {"anyOf": [{"type": "string"}, {"type": "null"}]}
    },
    "required": ["tipo_documento", "proveedor", "ruc_proveedor", "fecha_emision", "monto_total", "moneda", "categoria_gasto", "numero_documento", "items", "observaciones"],
    "additionalProperties": False
}

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
            "observaciones": ""
        }))
        return

    img_path = sys.argv[1]
    with open(img_path, 'rb') as f:
        b64 = base64.b64encode(f.read()).decode('utf-8')
    data_url = f"data:image/png;base64,{b64}"

    api_key = os.environ.get('OPENAI_API_KEY')
    model = (os.environ.get('OPENAI_MODEL') or 'gpt-4o-mini').strip()
    client = OpenAI(api_key=api_key)

    try:
        resp = client.chat.completions.create(
            model=model,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "text", "text": PROMPT},
                    {"type": "image_url", "image_url": {"url": data_url}}
                ]
            }],
            temperature=0.0,
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": "expense_extraction_es",
                    "strict": True,
                    "schema": SCHEMA,
                },
            },
        )
        text = resp.choices[0].message.content or "{}"
        # devolver tal cual; el wrapper Node hará JSON.parse
        print(text)
    except Exception as e:
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
            "error": f"llm error: {e}"
        }))

if __name__ == '__main__':
    main()