"""Normaliza las matrices causa-efecto DXD (troubleshooting/Matriz*.xlsx) a lo que aplica en todas las máquinas DXD.

Quita causas que no existen en estas máquinas y une las que dicen lo mismo (pines, DB9, flex, radio defectuoso, modelos,
colocación, pistón, reinicio de la aplicación…), resume su redacción, da el mismo nombre a los efectos comunes y quita
los TOP 6 a 10. Las causas que se unen conservan todas sus marcas. Correrlo de nuevo no cambia nada.
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

PINES = "Pines de los conectores dañados, desgastados, sucios o recalentados"
APP = "Aplicación trabada o sin comunicación (reiniciar la aplicación en la PC)"
# (regex sobre el texto sin acentos y en minúsculas, causa nueva o None = quitar). Gana la primera que coincide.
# Cada causa nueva vuelve a coincidir con su propia regla: correr el script otra vez no cambia nada.
CAUSAS = [
    # unir las que dicen lo mismo con otras palabras
    (r"mala (colocacion|colacion|alineacion)|mal colocado o desalineado", "Radio mal colocado o desalineado en el nido"),
    (r"^reiniciar (la )?aplicacion|perdida de comunicacion|aplicacion trabada", APP),
    (r"piston", "El pistón del conector de comunicación no actúa (revisar presión neumática)"),
    (r"^cables (rotos|de alimentacion)", "Cables de alimentación o comunicación del radio rotos"),
    (r"mala conexion usb|meroria usb|memoria usb no conectada", "Memoria USB no conectada o mal conectada (desconectar y conectar)"),
    (r"^(conector|cable) gps|cable o conector gps", "Cable o conector GPS dañado"),
    # redacción más corta y con acentos
    (r"^error de secuencia", "Error de secuencia (retirar los radios y reiniciar la aplicación)"),
    (r"^interrupcion de prueba|^prueba interrumpida",
     "Prueba interrumpida en un nido (se cerró su pestaña y perdió la secuencia): retirar el radio y reiniciar la aplicación"),
    (r"^tornilleria", "Tornillería de los conectores floja o faltante"),
    (r"^postes del jig", "Postes del JIG (rojos) mal ubicados o mal ajustados"),
    (r"comunicacion con equipo bt|equipo bt sin comunicacion", "Equipo BT sin comunicación (reiniciar el equipo BT y la aplicación)"),
    (r"^cable (de comunicacion )?pc", "Cable PC – equipo BT (USB / LAN) flojo o dañado"),
    (r"^path loss", "Path loss / calibración del equipo BT fuera de valor"),
    (r"^codigos id", "Códigos ID repetidos"),
    (r"estacion anterior", "El radio no pasó por la estación anterior (Process ID incompleto): regresarlo a la ruta"),
    (r"programa mal seleccionado", "Programa mal seleccionado en el nido (PRODUCTS EDIT)"),
    (r"^camara / colorimetro", "Cámara / colorímetro desenfocado o desalineado con el display"),
    (r"luz externa", "Entra luz externa a la cámara (puerta abierta) o lente sucio"),
    (r"^pantalla del radio sucia", "Pantalla del radio sucia, con huellas, película protectora o rayada"),
    (r"luminancia", "Equipo de medición de color / luminancia sin calibración"),
    (r"^actuador", "Actuador neumático (dedo) de botones desajustado, sin carrera o sin presión"),
    (r"^tarjeta de relevadores", "Tarjeta de relevadores sin comunicación (revisar cable y reiniciar el fixture)"),
    (r"^arnes de senales", "Arnés de señales de salida del fixture (RACM / ANT / SWD / CAM / USB) dañado o desconectado"),
    (r"senal de video", "Señal de video de cámara (RWC) no inyectada: generador o cable de video dañado"),
    (r"tracks incorrectos", "Memoria USB corrupta o con tracks incorrectos"),
    (r"conector bnc", "Conector BNC mal ensamblado"),
    (r"smart antena", "Cableado de la Smart Antena AM/FM dañado"),
    (r"guia de (la )?antena|antena fm/am guia", "Guía de la antena AM/FM desgastada"),
    (r"relevador mecanico", "Relevador mecánico de dos vías dañado (debajo de la base giratoria)"),
    (r"cable de antena", "Cable de antena demasiado largo"),
    (r"j2 al? fixture", "Cableado del conector J2 al fixture dañado"),
    (r"serie duplicado", "Número de serie duplicado en la etiqueta"),
    (r"enfoque del lector|lector de codigo desenfocado", "Lector de código desenfocado"),
    (r"hub usb", "Hub USB mal conectado"),
    # quitar lo que no existe en estas máquinas
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
    (r"\bups\b", "UPS apagado"),
    (r"perilla de encendido", "Perilla de encendido general apagada"),
    (r"swi?t?c?h principal", "Switch principal apagado"),
    (r"equipos de medicion y ?/ ?o fuente", "Equipos de medición y/o fuente de alimentación apagados"),
    (r"equipos de medicion alarmados", "Equipos de medición alarmados (no encendieron correctamente)"),
    (r"9 pines|db9", "Conector DB9 de comunicación levantado, desalineado o dañado"),
    (r"pines", PINES),
    (r"flexible", "Flexible del radio mal ensamblada"),
    (r"componentes incorrectos|radio danado|touch screen|display \(lcd\)|ventilador del radio|boton del radio",
     "Radio defectuoso"),
    (r"mezcla de radios|modelo que no corresponde|modelo no corresponde|diferente modelo",
     "Modelo de radio diferente al que se está procesando"),
    (r"^guias defectuosas", "Guías defectuosas"),
]
# TOP 6 a 10: se dejan solo las 5 fallas más frecuentes de cada máquina
EFECTOS_QUITAR = r"canfd|canopenchannel|mediator|^TOP ([6-9]|10)\b"
EFECTOS_CAMBIAR = [(r"\s*/\s*fdoor NG", " NG"), (r"\s*/\s*UA4700Plugin", ""), (r"\blimite\b", "límite"),
                   (r"\bColorimetria\b", "Colorimetría"), (r"\bcamara\b", "cámara"), (r"\bboton\b", "botón")]
# (regex sobre el efecto sin acentos y en minúsculas, efecto nuevo): mismo nombre en todas las máquinas
EFECTOS = [
    (r"^la maquina no enciende", "La máquina no enciende"),
    (r"no entra correctamente en el nido", "El radio no entra correctamente en el nido"),
    (r"^no enciende radio|^el radio no enciende", "El radio no enciende (botones y perilla sin respuesta)"),
    (r"^aplicacion congelada", "Aplicación congelada (el tiempo de operación no avanza)"),
    (r"^error de id", "Error de ID del material"),
    (r"^display no enciende pero s", "El display no enciende, pero sí realiza las pruebas"),
    (r"^top 2 - usb_fl", "TOP 2 - USB_FL check error (audio USB, canal FL)"),
    (r"^top 4 - usb_play_track_2", "TOP 4 - USB_Play_Track_2 ERROR (no inicia la reproducción del track 2)"),
    (r"^error audio measur?ment mw", "Error Audio Measurement MW - AutoStop (1000 kHz o 98.1 MHz)"),
    (r"^error audio measur?ment bt", "Error Audio Measurement BT"),
    (r"^inspeccion anc", "Inspección ANC NG"),
]


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
        efecto = next((nuevo for p, nuevo in EFECTOS if re.search(p, sin_acentos(efecto))), efecto.strip())
        nuevas = [nueva_causa(causas[c.column]) for c in row[3:] if c.value and c.column in causas]
        filas.append((row[0].value, efecto, categoria, [n for n in nuevas if n]))

    # solo las causas que algún efecto usa (las de los efectos quitados se van con ellos)
    usadas = {n for f in filas for n in f[3]}
    orden = list(dict.fromkeys(n for c in sorted(causas) for n in [nueva_causa(causas[c])] if n in usadas))
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
