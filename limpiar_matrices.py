"""Normaliza las matrices causa-efecto DXD (troubleshooting/Matriz*.xlsx) a lo que aplica en todas las máquinas DXD.

Quita causas que no existen en estas máquinas y une las que dicen lo mismo (pines, DB9, flex, radio defectuoso, modelos).
Las causas que se unen conservan todas sus marcas. Se corre una vez; correrlo de nuevo no cambia nada.
    py limpiar_matrices.py
"""
import re
import shutil
import unicodedata
from pathlib import Path

import openpyxl
from copy import copy

BASE = Path(__file__).parent
RESPALDO = BASE / "_respaldo_matrices"

PINES = "Pines de los conectores (principal, comunicación, intercambiable o J2) dañados, desgastados, sucios o recalentados"
# (regex sobre el texto sin acentos y en minúsculas, causa nueva o None = quitar). Gana la primera que coincide.
CAUSAS = [
    (r"boton \(azul\) de reset", None),
    (r"ua4700", None),
    (r"fdoor", None),
    (r"nido abortado", None),
    (r"bracket", None),
    (r"\(tpx\)|punta de prueba del touch", None),
    (r"antena wifi", None),
    (r"interfaz can\b", None),
    (r"error interno de software del plugin", None),
    (r"mes / itac", None),
    (r"mediator", None),
    (r"k-line", None),
    (r"tp-link", "Falla de conectividad WiFi"),
    (r"\bups\b", "El UPS está apagado"),
    (r"perilla de encendido", "La perilla de encendido general del equipo está apagada"),
    (r"swi?t?c?h principal", "Switch principal apagado"),
    (r"equipos de medicion y ?/ ?o fuente", "Equipos de medición y/o fuente de alimentación apagados"),
    (r"equipos de medicion alarmados", "Equipos de medición alarmados (no encendieron correctamente)"),
    (r"^reiniciar (la )?aplicacion", "Reiniciar la aplicación en la PC"),
    (r"perdida de comunicacion", "Pérdida de comunicación (reiniciar la aplicación)"),
    (r"9 pines|db9", "Conector DB9 de comunicación levantado, desalineado o dañado"),
    (r"pines", PINES),
    (r"flexible", "Flexible del radio mal ensamblada"),
    (r"componentes incorrectos|radio danado|touch screen|display \(lcd\)|ventilador del radio|boton del radio",
     "Radio defectuoso"),
    (r"mezcla de radios|modelo que no corresponde|modelo no corresponde|diferente modelo",
     "Modelo de radio diferente al que se está procesando"),
    (r"mala colacion|mala colocacion", "Mala colocación del radio"),
    (r"^guias defectuosas", "Guías defectuosas"),
]
EFECTOS_QUITAR = r"canfd|canopenchannel|mediator"
EFECTOS_CAMBIAR = [(r"\s*/\s*fdoor NG", " NG"), (r"\s*/\s*UA4700Plugin", "")]


def sin_acentos(s):
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()


def nueva_causa(texto):
    t = re.sub(r"\s+", " ", texto).strip()
    for patron, nueva in CAUSAS:
        if re.search(patron, sin_acentos(t)):
            return nueva
    t = re.sub(r",?\s*(verificar|prueba|probar) con radio master", "", t, flags=re.I)
    return t[:1].upper() + t[1:]


def limpiar_hoja(ws):
    causas = {c.column: str(c.value) for c in ws[1][3:] if c.value is not None and str(c.value).strip()}
    marca = next((str(c.value) for row in ws.iter_rows(min_row=3, min_col=4) for c in row if c.value), "ꙩ")
    estilo_t, estilo_n, estilo_m = ws.cell(1, 4), ws.cell(2, 4), ws.cell(3, 4)

    filas, categoria = [], ""
    for row in ws.iter_rows(min_row=3):
        categoria = str(row[2].value).strip() if row[2].value else categoria
        if not row[1].value:
            continue
        efecto = str(row[1].value)
        if re.search(EFECTOS_QUITAR, efecto, re.I):
            continue
        for p, r in EFECTOS_CAMBIAR:
            efecto = re.sub(p, r, efecto)
        nuevas = [nueva_causa(causas[c.column]) for c in row[3:] if c.value and c.column in causas]
        filas.append((row[0].value, efecto, categoria, [n for n in nuevas if n]))

    orden = list(dict.fromkeys(n for c in sorted(causas) for n in [nueva_causa(causas[c])] if n))
    for m in list(ws.merged_cells.ranges):
        if m.min_col == 3:
            ws.unmerge_cells(str(m))
    for row in ws.iter_rows(min_row=1):
        for c in row:
            if c.column > 3 or (c.row >= 3 and c.column <= 3):
                c.value = None
    for i, nombre in enumerate(orden):
        col = 4 + i
        for r, val, est in ((1, nombre, estilo_t), (2, i + 1, estilo_n)):
            c = ws.cell(r, col, val)
            c._style = copy(est._style)
    for r, (n, efecto, cat, nuevas) in enumerate(filas, 3):
        ws.cell(r, 1, n), ws.cell(r, 2, efecto), ws.cell(r, 3, cat)
        for i, nombre in enumerate(orden):
            c = ws.cell(r, 4 + i, marca if nombre in nuevas else None)
            c._style = copy(estilo_m._style)
    # categoría en celda combinada, como el original
    inicio = 3
    for r in range(3, 3 + len(filas) + 1):
        if r == 3 + len(filas) or filas[r - 3][2] != filas[inicio - 3][2]:
            if r - 1 > inicio:
                for k in range(inicio + 1, r):
                    ws.cell(k, 3).value = None
                ws.merge_cells(start_row=inicio, start_column=3, end_row=r - 1, end_column=3)
            inicio = r
    for r in range(3 + len(filas), ws.max_row + 1):
        for c in ws[r]:
            c.value = None
    return len(causas), len(orden), len(filas)


if __name__ == "__main__":
    RESPALDO.mkdir(exist_ok=True)
    for p in sorted((BASE / "troubleshooting").glob("Matriz*.xlsx")):
        if not (RESPALDO / p.name).exists():
            shutil.copy2(p, RESPALDO / p.name)
        wb = openpyxl.load_workbook(p)
        for ws in wb.worksheets:
            antes, despues, efectos = limpiar_hoja(ws)
            print(f"{p.name} [{ws.title}]: {antes} -> {despues} causas, {efectos} efectos")
        wb.save(p)
