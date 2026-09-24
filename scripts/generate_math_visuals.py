#!/usr/bin/env python3
"""Create compact original SVG teaching diagrams used by prepared plans."""

from pathlib import Path


STYLE = """<style>
text{font-family:Arial,sans-serif;fill:#14213d;font-size:15px}.label{font-weight:700}
.axis{stroke:#334155;stroke-width:2}.shape{stroke:#2563eb;stroke-width:3;fill:none}
.accent{stroke:#f97316;stroke-width:3;fill:none}.soft{fill:#dbeafe;stroke:#2563eb;stroke-width:2}
.grid{stroke:#cbd5e1;stroke-width:1}.dash{stroke:#64748b;stroke-width:2;stroke-dasharray:6 5;fill:none}
</style>"""


def svg(body: str, title: str) -> str:
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="620" height="280" viewBox="0 0 620 280" role="img" aria-labelledby="title desc">
<title id="title">{title}</title><desc id="desc">ҚМЖ тапсырмасына арналған авторлық математикалық сызба</desc>{STYLE}
<rect width="620" height="280" rx="18" fill="#f8fafc"/>{body}</svg>'''


VISUALS = {
"fraction-bars": svg('''<text x="30" y="36" class="label">Бөлшек жолақтары</text><rect x="45" y="75" width="480" height="48" class="shape"/><path d="M105 75v48m60-48v48m60-48v48m60-48v48m60-48v48m60-48v48m60-48v48" class="axis"/><rect x="45" y="75" width="180" height="48" fill="#93c5fd"/><rect x="225" y="75" width="120" height="48" fill="#fdba74"/><text x="45" y="165">Боялған бөліктерді ортақ бөліммен қос.</text>''', "Бөлшек жолақтары"),
"number-line": svg('''<text x="30" y="36" class="label">Сан сәулесі</text><path d="M55 145H565m-12-8 12 8-12 8" class="axis"/><g class="axis"><path d="M125 132v26m80-26v26m80-26v26m80-26v26m80-26v26"/></g><g><text x="116" y="182">−2</text><text x="198" y="182">−1</text><text x="280" y="182">0</text><text x="361" y="182">1</text><text x="441" y="182">2</text></g><circle cx="365" cy="145" r="7" fill="#f97316"/>''', "Сан сәулесі"),
"percent-grid": svg('''<text x="30" y="30" class="label">100 бөлік үлгісі</text><defs><pattern id="g" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" class="grid" fill="none"/></pattern></defs><rect x="65" y="50" width="200" height="200" fill="url(#g)" stroke="#334155"/><rect x="65" y="50" width="80" height="200" fill="#93c5fd" opacity=".8"/><text x="310" y="125">Боялған бөлік: 40%</text><text x="310" y="160">40/100 = 0,4</text>''', "Пайыздық тор"),
"coordinate-plane": svg('''<text x="30" y="30" class="label">Координаталық жазықтық</text><path d="M60 230H570m-10-7 10 7-10 7M300 250V45m-7 10 7-10 7 10" class="axis"/><path d="M95 215L520 75" class="shape"/><circle cx="385" cy="120" r="6" fill="#f97316"/><text x="395" y="112">(x; y)</text><text x="550" y="250">x</text><text x="315" y="58">y</text>''', "Координаталық жазықтық"),
"square-root-area": svg('''<text x="30" y="30" class="label">Квадрат ауданы және түбір</text><rect x="90" y="55" width="180" height="180" class="soft"/><path d="M90 245h180" class="accent"/><text x="155" y="265">√S</text><text x="350" y="115">S = a²</text><text x="350" y="155">a = √S</text>''', "Квадрат түбірдің аудандық моделі"),
"exponential-log": svg('''<text x="30" y="30" class="label">Көрсеткіштік және логарифмдік байланыс</text><path d="M60 230H570M120 250V45" class="axis"/><path d="M140 215C220 210 285 190 340 150S450 65 535 55" class="shape"/><text x="360" y="100">y = aˣ</text><text x="300" y="255">aˣ=b ⇔ logₐb=x</text>''', "Көрсеткіштік функция графигі"),
"function-tangent": svg('''<text x="30" y="30" class="label">Функция және жанама</text><path d="M60 230H570M300 250V45" class="axis"/><path d="M95 215Q300 35 520 215" class="shape"/><path d="M175 205L470 70" class="accent"/><circle cx="330" cy="134" r="6" fill="#f97316"/><text x="345" y="128">f′(x₀)</text>''', "Функция графигіне жанама"),
"area-under-curve": svg('''<text x="30" y="30" class="label">Қисық астындағы аудан</text><path d="M60 230H570M100 250V45" class="axis"/><path d="M120 205Q260 60 500 95" class="shape"/><path d="M170 181Q270 80 410 93V230H170Z" fill="#bfdbfe" opacity=".8"/><path d="M170 230V181M410 230V93" class="dash"/><text x="245" y="260">∫ f(x)dx</text>''', "Интегралдың аудан моделі"),
"function-hole": svg('''<text x="30" y="30" class="label">Шек және жойылатын үзіліс</text><path d="M60 230H570M300 250V45" class="axis"/><path d="M95 210L520 65" class="shape"/><circle cx="350" cy="123" r="9" fill="#f8fafc" stroke="#f97316" stroke-width="3"/><text x="365" y="118">x → a</text>''', "Функция графигіндегі бос нүкте"),
"slope-field": svg('''<text x="30" y="30" class="label">Бағыттар өрісі</text><path d="M60 230H570M300 250V45" class="axis"/><g class="shape"><path d="M110 190l25-8m65-2 25-2m65-8 25 2m65-12 25 8m65-18 25 12M110 125l25-15m65 5 25-8m65 2 25 2m65-4 25 8m65-16 25 15M110 70l25-20m65 10 25-14m65 10 25-6m65 0 25 6m65-16 25 20"/></g>''', "Дифференциалдық теңдеудің бағыттар өрісі"),
"unit-circle": svg('''<text x="30" y="30" class="label">Бірлік шеңбер</text><circle cx="250" cy="145" r="95" class="shape"/><path d="M120 145H380M250 250V40" class="axis"/><path d="M250 145L332 98M332 98V145" class="accent"/><text x="292" y="112">α</text><text x="338" y="125">sin α</text><text x="275" y="165">cos α</text>''', "Бірлік шеңбер"),
"probability-tree": svg('''<text x="30" y="30" class="label">Ықтималдық ағашы</text><circle cx="90" cy="140" r="6" fill="#334155"/><path d="M96 140L220 80M96 140l124 60M225 80l120-35m-120 35 120 35m-120 85 120-35m-120 35 120 35" class="shape"/><g><text x="160" y="94">Е</text><text x="160" y="194">С</text><text x="360" y="50">ЕЕ</text><text x="360" y="120">ЕС</text><text x="360" y="170">СЕ</text><text x="360" y="240">СС</text></g>''', "Ықтималдық ағашы"),
"bar-chart": svg('''<text x="30" y="30" class="label">Жиілік диаграммасы</text><path d="M70 230H560M90 245V55" class="axis"/><rect x="135" y="165" width="55" height="65" class="soft"/><rect x="235" y="105" width="55" height="125" class="soft"/><rect x="335" y="75" width="55" height="155" class="soft"/><rect x="435" y="135" width="55" height="95" class="soft"/><text x="150" y="255">1</text><text x="250" y="255">2</text><text x="350" y="255">3</text><text x="450" y="255">4</text>''', "Бағанды диаграмма"),
"sequence-chart": svg('''<text x="30" y="30" class="label">Сандар тізбегі</text><circle cx="90" cy="145" r="28" class="soft"/><circle cx="220" cy="145" r="28" class="soft"/><circle cx="350" cy="145" r="28" class="soft"/><circle cx="480" cy="145" r="28" class="soft"/><path d="M120 145h70m60 0h70m60 0h70" class="axis"/><text x="83" y="151">a₁</text><text x="211" y="151">a₂</text><text x="341" y="151">a₃</text><text x="471" y="151">aₙ</text><text x="160" y="125">+d</text><text x="290" y="125">+d</text>''', "Арифметикалық прогрессия"),
"parabola": svg('''<text x="30" y="30" class="label">Квадраттық функция</text><path d="M60 230H570M300 250V45" class="axis"/><path d="M130 70Q300 300 485 70" class="shape"/><circle cx="205" cy="230" r="6" fill="#f97316"/><circle cx="410" cy="230" r="6" fill="#f97316"/><text x="190" y="260">x₁</text><text x="400" y="260">x₂</text>''', "Парабола және түбірлер"),
"linear-system": svg('''<text x="30" y="30" class="label">Екі теңдеудің графиктік шешімі</text><path d="M60 230H570M300 250V45" class="axis"/><path d="M100 210L505 70" class="shape"/><path d="M120 65L500 220" class="accent"/><circle cx="310" cy="137" r="7" fill="#111827"/><text x="325" y="132">(x; y)</text>''', "Сызықтық теңдеулер жүйесі"),
"linear-function": svg('''<text x="30" y="30" class="label">Сызықтық функция</text><path d="M60 230H570M300 250V45" class="axis"/><path d="M110 220L510 70" class="shape"/><path d="M300 145h16M308 137v16" class="accent"/><text x="325" y="146">b</text><text x="420" y="105">y=kx+b</text>''', "Сызықтық функция графигі"),
"coordinate-vector": svg('''<text x="30" y="30" class="label">Координаталар және вектор</text><path d="M60 230H570M270 250V45" class="axis"/><circle cx="340" cy="185" r="6" fill="#2563eb"/><circle cx="480" cy="90" r="6" fill="#f97316"/><path d="M340 185L472 96m-12 0 12 0 0 12" class="accent"/><text x="315" y="205">A</text><text x="490" y="88">B</text>''', "Координаталық вектор"),
"circle-elements": svg('''<text x="30" y="30" class="label">Шеңбер элементтері</text><circle cx="260" cy="145" r="95" class="shape"/><path d="M260 145L350 115M165 145H355M355 55V235" class="accent"/><text x="290" y="125">r</text><text x="225" y="165">d</text><text x="370" y="80">жанама</text>''', "Шеңбердің элементтері"),
"right-triangle": svg('''<text x="30" y="30" class="label">Тікбұрышты үшбұрыш</text><path d="M115 225H480L115 65Z" class="shape"/><path d="M115 205h20v20" class="axis"/><text x="280" y="250">a</text><text x="82" y="150">b</text><text x="300" y="130">c</text><text x="360" y="55">a²+b²=c²</text>''', "Пифагор теоремасы"),
"similar-triangles": svg('''<text x="30" y="30" class="label">Ұқсас үшбұрыштар</text><path d="M60 220H250L115 85Z" class="shape"/><path d="M330 220H570L400 50Z" class="accent"/><text x="120" y="250">△ABC</text><text x="405" y="250">△A₁B₁C₁</text><text x="255" y="140">k</text>''', "Ұқсас үшбұрыштар"),
"parallelogram-area": svg('''<text x="30" y="30" class="label">Параллелограмм ауданы</text><path d="M120 215H450L510 75H180Z" class="shape"/><path d="M180 75V215" class="dash"/><path d="M165 200h15v15" class="axis"/><text x="290" y="245">a</text><text x="190" y="150">h</text><text x="405" y="45">S=ah</text>''', "Параллелограмм ауданы"),
"cylinder": svg('''<text x="30" y="30" class="label">Цилиндр</text><ellipse cx="270" cy="70" rx="105" ry="35" class="shape"/><path d="M165 70v140m210-140v140" class="shape"/><ellipse cx="270" cy="210" rx="105" ry="35" class="shape"/><path d="M270 70H375M270 70V210" class="accent"/><text x="325" y="60">r</text><text x="280" y="145">h</text><text x="420" y="140">V=πr²h</text>''', "Цилиндрдің көлемі"),
"parallel-lines": svg('''<text x="30" y="30" class="label">Параллель түзулер және қиюшы</text><path d="M70 95H550M70 205H550" class="shape"/><path d="M205 245L410 50" class="accent"/><path d="M250 95a34 34 0 0 1 22 26M365 205a34 34 0 0 1-22-26" class="axis"/><text x="265" y="85">α</text><text x="335" y="230">α</text>''', "Параллель түзулер"),
}


def main() -> None:
    target = Path(__file__).resolve().parents[1] / "public" / "visuals"
    target.mkdir(parents=True, exist_ok=True)
    for name, content in VISUALS.items():
        (target / f"{name}.svg").write_text(content, encoding="utf-8")
    print(f"generated={len(VISUALS)} directory={target}")


if __name__ == "__main__":
    main()
