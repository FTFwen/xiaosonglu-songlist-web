'use strict';

const SUITS = [
    { symbol: '♥', color: 'red' },
    { symbol: '♦', color: 'red' },
    { symbol: '♣', color: 'black' },
    { symbol: '♠', color: 'black' }
];

const EPSILON = 1e-9;

let cards = [];
let initialCards = [];
let selectedCard = null;
let selectedOperator = null;
let calculationSteps = [];
let solvedCount = 0;
let currentSolution = null;
let gameActive = false;
let isAutoPlaying = false;
let gameVersion = 0;
let autoNodeToCardIndex = new Map();

const gameTimers = new Set();
const messageTimers = new Set();

const cardsContainer = document.getElementById('cards-container');
const calculationDisplay = document.getElementById('calculation-display');
const messageContainer = document.getElementById('message-container');
const solvedCountEl = document.getElementById('solved-count');
const celebrationEl = document.getElementById('celebration');
const noSolutionButton = document.getElementById('no-solution-btn');
const operatorButtons = [...document.querySelectorAll('.operator-btn[data-operator]')];
let activeAnimations = [];

function sameNumber(a, b) {
    return Math.abs(a - b) < EPSILON;
}

function valueKey(value) {
    const normalized = sameNumber(value, 0) ? 0 : value;
    return (Math.round(normalized * 1e9) / 1e9).toString();
}

function greatestCommonDivisor(a, b) {
    let left = Math.abs(a);
    let right = Math.abs(b);
    while (right !== 0) {
        const remainder = left % right;
        left = right;
        right = remainder;
    }
    return left || 1;
}

function formatNumber(value) {
    if (!Number.isFinite(value)) return '无效';
    if (sameNumber(value, 0)) return '0';

    const rounded = Math.round(value);
    if (sameNumber(value, rounded)) return rounded.toString();

    const sign = value < 0 ? -1 : 1;
    const absolute = Math.abs(value);

    for (let denominator = 2; denominator <= 1000; denominator++) {
        const numerator = Math.round(absolute * denominator);
        if (Math.abs(numerator / denominator - absolute) < EPSILON) {
            const divisor = greatestCommonDivisor(numerator, denominator);
            const finalNumerator = sign * (numerator / divisor);
            const finalDenominator = denominator / divisor;
            return `${finalNumerator}/${finalDenominator}`;
        }
    }

    return Number(value.toFixed(4)).toString();
}

function getRankDisplay(value) {
    switch (value) {
        case 1: return 'A';
        case 11: return 'J';
        case 12: return 'Q';
        case 13: return 'K';
        default: return value.toString();
    }
}

function getCardLabel(card) {
    if (card.isOriginal && Number.isInteger(card.value) && card.value >= 1 && card.value <= 13) {
        return getRankDisplay(card.value);
    }
    return formatNumber(card.value);
}

function cloneCards(source) {
    return source.map(card => ({
        id: card.id,
        value: card.value,
        suitIndex: card.suitIndex,
        used: card.used,
        isOriginal: card.isOriginal,
        element: null
    }));
}

function setGameTimer(callback, delay, version = gameVersion) {
    const timerId = setTimeout(() => {
        gameTimers.delete(timerId);
        if (version !== gameVersion) return;
        callback();
    }, delay);
    gameTimers.add(timerId);
    return timerId;
}

function cancelGameTimers() {
    gameTimers.forEach(timerId => clearTimeout(timerId));
    gameTimers.clear();
}

function clearMessageTimers() {
    messageTimers.forEach(timerId => clearTimeout(timerId));
    messageTimers.clear();
}

function removeDealAnimations() {
    activeAnimations.forEach(animation => {
        if (animation && typeof animation.cancel === 'function') animation.cancel();
    });
    activeAnimations = [];
    document.querySelectorAll('.dealing-animation').forEach(element => element.remove());
}

function clearOperatorSelection() {
    operatorButtons.forEach(button => button.classList.remove('selected', 'auto-highlight'));
    selectedOperator = null;
}

function clearAutoHighlights() {
    cards.forEach(card => {
        if (card.element) card.element.classList.remove('auto-highlight', 'selected');
    });
    clearOperatorSelection();
}

function beginNewVersion() {
    cancelGameTimers();
    gameVersion++;
    removeDealAnimations();
    clearAutoHighlights();
    cardsContainer.classList.remove('awaiting-second');
    celebrationEl.classList.remove('show');
    celebrationEl.innerHTML = '';
}

function initGame() {
    beginNewVersion();

    selectedCard = null;
    selectedOperator = null;
    calculationSteps = [];
    currentSolution = null;
    gameActive = false;
    isAutoPlaying = false;
    autoNodeToCardIndex = new Map();

    cardsContainer.innerHTML = '';
    cards = [];

    for (let index = 0; index < 4; index++) {
        const value = Math.floor(Math.random() * 13) + 1;
        const suitIndex = Math.floor(Math.random() * SUITS.length);
        cards.push({
            id: `card-${index}`,
            value,
            suitIndex,
            used: false,
            isOriginal: true,
            element: null
        });
    }

    initialCards = cloneCards(cards);
    currentSolution = find24Solution(cards);
    updateCalculationDisplay();
    clearMessages();
    createCards();
    showDealAnimation(gameVersion);
}

function showDealAnimation(version) {
    const marker = document.createElement('div');
    marker.className = 'dealing-animation';
    marker.setAttribute?.('aria-hidden', 'true');
    document.body.appendChild(marker);

    const cardElements = cards.map(card => card.element).filter(Boolean);
    const supportsAnimation = cardElements.length === 4
        && typeof cardElements[0].animate === 'function'
        && typeof cardElements[0].getBoundingClientRect === 'function';

    if (supportsAnimation) {
        const reducedMotion = typeof window.matchMedia === 'function'
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const duration = reducedMotion ? 120 : 1180;
        const cardRects = cardElements.map(element => element.getBoundingClientRect());
        const centerX = cardRects.reduce((sum, rect) => sum + rect.left + rect.width / 2, 0) / cardRects.length;
        const rotations = [-7, -2, 2, 7];

        activeAnimations = cardElements.map((element, index) => {
            const rect = cardRects[index];
            const cardCenter = rect.left + rect.width / 2;
            const stackedX = centerX - cardCenter;
            const fanCenter = centerX + (index - 1.5) * rect.width * 0.63;
            const fanX = fanCenter - cardCenter;
            return element.animate([
                { transform: `translateX(${stackedX}px) translateY(8px) rotate(0deg) scale(.91)`, opacity: 0, offset: 0 },
                { transform: `translateX(${stackedX}px) translateY(2px) rotate(0deg) scale(.96)`, opacity: 1, offset: 0.14 },
                { transform: `translateX(${fanX}px) translateY(-5px) rotate(${rotations[index]}deg) scale(1)`, opacity: 1, offset: 0.52 },
                { transform: `translateX(${fanX}px) translateY(-5px) rotate(${rotations[index]}deg) scale(1)`, opacity: 1, offset: 0.68 },
                { transform: 'translateX(0) translateY(0) rotate(0deg) scale(1)', opacity: 1, offset: 1 }
            ], {
                duration,
                delay: reducedMotion ? 0 : index * 35,
                easing: 'cubic-bezier(.2,.72,.22,1)',
                fill: 'both'
            });
        });
    }

    setGameTimer(() => {
        marker.remove();
        activeAnimations.forEach(animation => {
            if (animation && typeof animation.cancel === 'function') animation.cancel();
        });
        activeAnimations = [];
        gameActive = true;
        showMessage('选择一张牌开始', 'info');
    }, supportsAnimation ? 1320 : 1, version);
}

function createCards() {
    cardsContainer.innerHTML = '';

    cards.forEach((card, index) => {
        const cardEl = document.createElement('button');
        cardEl.className = `card ${card.used ? 'used' : ''}`;
        cardEl.dataset.index = index;
        cardEl.type = 'button';
        cardEl.setAttribute?.('aria-label', `${getCardLabel(card)} ${SUITS[card.suitIndex].symbol}`);

        const valueEl = document.createElement('div');
        valueEl.className = 'card-value';
        valueEl.textContent = getCardLabel(card);
        valueEl.classList.toggle?.('long-value', valueEl.textContent.length >= 3);

        const suitEl = document.createElement('div');
        const suit = SUITS[card.suitIndex];
        suitEl.className = `card-suit ${suit.color}`;
        suitEl.textContent = suit.symbol;

        cardEl.appendChild(valueEl);
        cardEl.appendChild(suitEl);
        cardEl.addEventListener('click', () => handleCardClick(index));

        cardsContainer.appendChild(cardEl);
        card.element = cardEl;
    });
}

function handleCardClick(index) {
    if (!gameActive || isAutoPlaying || cards[index].used) return;

    if (selectedCard === null) {
        selectedCard = index;
        cards[index].element.classList.add('selected');
        cardsContainer.classList.add('awaiting-second');
        showMessage('选择运算符', 'info');
        return;
    }

    if (selectedCard === index) {
        resetSelection();
        showMessage('已取消', 'info');
        return;
    }

    if (selectedOperator === null) {
        showMessage('请先选择运算符', 'info');
        return;
    }

    performCalculation(selectedCard, index, selectedOperator);
}

function selectOperator(button) {
    if (!gameActive || isAutoPlaying) return;
    if (selectedCard === null) {
        showMessage('先选牌', 'info');
        return;
    }

    operatorButtons.forEach(item => item.classList.remove('selected'));
    button.classList.add('selected');
    selectedOperator = button.dataset.operator;
    showMessage('选另一张牌', 'info');
}

operatorButtons.forEach(button => {
    button.addEventListener('click', () => selectOperator(button));
});

function applyOperation(value1, value2, operator) {
    switch (operator) {
        case '+':
            return { result: value1 + value2, error: null };
        case '-': {
            const result = value1 - value2;
            if (result <= 0) {
                return { result: null, error: '减法结果必须是正整数' };
            }
            return { result, error: null };
        }
        case '×':
            return { result: value1 * value2, error: null };
        case '÷':
            if (sameNumber(value2, 0) || value1 % value2 !== 0) {
                return { result: null, error: '除法必须能够整除' };
            }
            return { result: value1 / value2, error: null };
        default:
            return { result: null, error: '请选择运算符' };
    }
}

function performCalculation(index1, index2, operator) {
    const card1 = cards[index1];
    const card2 = cards[index2];
    if (!card1 || !card2 || card1.used || card2.used || index1 === index2) return;

    const operation = applyOperation(card1.value, card2.value, operator);

    if (operation.error || !Number.isFinite(operation.result)) {
        showMessage(operation.error || '无法完成这次计算', 'error');
        [card1.element, card2.element].forEach(element => {
            element.classList.add('invalid');
            setGameTimer(() => element.classList.remove('invalid'), 380);
        });
        resetSelection();
        return;
    }

    const result = operation.result;

    const operationText = `${formatNumber(card1.value)} ${operator} ${formatNumber(card2.value)} = ${formatNumber(result)}`;

    card1.used = true;
    card1.element.classList.add('used');

    card2.value = result;
    card2.isOriginal = false;
    const resultElement = card2.element.querySelector('.card-value');
    resultElement.textContent = formatNumber(result);
    resultElement.classList.toggle?.('long-value', resultElement.textContent.length >= 3);
    resultElement.classList.remove('result-pop');
    void resultElement.offsetWidth;
    resultElement.classList.add('result-pop');

    calculationSteps.push(operationText);
    resetSelection();
    updateCalculationDisplay();

    const ended = checkGameEnd();
    if (!ended) showMessage('计算成功', 'success');
}

function checkGameEnd() {
    const remainingCards = cards.filter(card => !card.used);
    if (remainingCards.length !== 1) return false;

    gameActive = false;
    const lastCard = remainingCards[0];

    if (sameNumber(lastCard.value, 24)) {
        solvedCount++;
        solvedCountEl.textContent = solvedCount;
        showCelebration();
        showMessage('太棒了！计算正确！', 'success');
        setGameTimer(() => initGame(), 2000);
    } else {
        showMessage(`最终结果是 ${formatNumber(lastCard.value)}，不是24`, 'error');
        lastCard.element.classList.add('error');
        setGameTimer(() => resetCalculation(), 2000);
    }

    return true;
}

function showCelebration() {
    celebrationEl.innerHTML = '';
    celebrationEl.classList.add('show');

    const colors = ['#e8b954', '#a8b095', '#8f776b', '#f1e9db', '#d98b86'];

    for (let index = 0; index < 30; index++) {
        const confetti = document.createElement('div');
        const duration = Math.random() * 2 + 2;
        const delay = Math.random() * 0.8;

        confetti.className = 'confetti';
        confetti.style.left = `${Math.random() * 100}vw`;
        confetti.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
        confetti.style.setProperty('--rotation', `${Math.random() * 720 - 360}deg`);
        confetti.style.setProperty('--drift', `${Math.random() * 180 - 90}px`);
        confetti.style.animation = `confettiFall ${duration}s ease-out ${delay}s forwards`;
        celebrationEl.appendChild(confetti);
    }

    setGameTimer(() => {
        celebrationEl.classList.remove('show');
        celebrationEl.innerHTML = '';
    }, 3000);
}

function resetSelection() {
    if (selectedCard !== null && cards[selectedCard] && cards[selectedCard].element) {
        cards[selectedCard].element.classList.remove('selected');
    }
    selectedCard = null;
    cardsContainer.classList.remove('awaiting-second');
    clearOperatorSelection();
}

function updateCalculationDisplay() {
    if (calculationSteps.length === 0) {
        calculationDisplay.textContent = '点击牌开始计算';
        calculationDisplay.style.color = '#877f75';
        return;
    }

    calculationDisplay.textContent = calculationSteps.join(' → ');
    calculationDisplay.style.color = '#51473f';
}

function showMessage(text, type = 'info') {
    clearMessages();

    const messageEl = document.createElement('div');
    messageEl.className = `message ${type}`;
    messageEl.textContent = text;
    messageContainer.appendChild(messageEl);

    const showTimer = setTimeout(() => {
        messageTimers.delete(showTimer);
        messageEl.classList.add('show');
    }, 10);
    messageTimers.add(showTimer);

    const hideTimer = setTimeout(() => {
        messageTimers.delete(hideTimer);
        messageEl.classList.remove('show');

        const removeTimer = setTimeout(() => {
            messageTimers.delete(removeTimer);
            if (messageEl.parentNode === messageContainer) messageEl.remove();
        }, 300);
        messageTimers.add(removeTimer);
    }, 3000);
    messageTimers.add(hideTimer);
}

function clearMessages() {
    clearMessageTimers();
    messageContainer.innerHTML = '';
}

function operationCandidates(nodeA, nodeB) {
    const candidates = [
        { left: nodeA, right: nodeB, operator: '+', result: nodeA.value + nodeB.value },
        { left: nodeA, right: nodeB, operator: '×', result: nodeA.value * nodeB.value }
    ];

    if (nodeA.value - nodeB.value > 0) {
        candidates.push({ left: nodeA, right: nodeB, operator: '-', result: nodeA.value - nodeB.value });
    }
    if (nodeB.value - nodeA.value > 0) {
        candidates.push({ left: nodeB, right: nodeA, operator: '-', result: nodeB.value - nodeA.value });
    }
    if (!sameNumber(nodeB.value, 0) && nodeA.value % nodeB.value === 0) {
        candidates.push({ left: nodeA, right: nodeB, operator: '÷', result: nodeA.value / nodeB.value });
    }
    if (!sameNumber(nodeA.value, 0) && nodeB.value % nodeA.value === 0) {
        candidates.push({ left: nodeB, right: nodeA, operator: '÷', result: nodeB.value / nodeA.value });
    }

    const unique = new Map();
    candidates.forEach(candidate => {
        if (!Number.isInteger(candidate.result) || candidate.result <= 0 || candidate.result > 1e6) return;
        const key = `${candidate.left.id}|${candidate.operator}|${candidate.right.id}|${valueKey(candidate.result)}`;
        if (!unique.has(key)) unique.set(key, candidate);
    });

    return [...unique.values()].sort((first, second) => {
        const firstScore = (Number.isInteger(first.result) ? 0 : 8) + (first.result < 0 ? 3 : 0) + (first.operator === '÷' ? 1 : 0);
        const secondScore = (Number.isInteger(second.result) ? 0 : 8) + (second.result < 0 ? 3 : 0) + (second.operator === '÷' ? 1 : 0);
        return firstScore - secondScore;
    });
}

function find24Solution(sourceCards) {
    const initialNodes = sourceCards.map(card => ({
        id: card.id,
        value: card.value,
        label: formatNumber(card.value)
    }));

    const failedStates = new Set();
    let generatedNodeId = 0;

    function dfs(nodes, steps) {
        if (nodes.length === 1) {
            return sameNumber(nodes[0].value, 24) ? steps : null;
        }

        const stateKey = nodes.map(node => valueKey(node.value)).sort().join('|');
        if (failedStates.has(stateKey)) return null;

        for (let firstIndex = 0; firstIndex < nodes.length; firstIndex++) {
            for (let secondIndex = firstIndex + 1; secondIndex < nodes.length; secondIndex++) {
                const remaining = nodes.filter((_, index) => index !== firstIndex && index !== secondIndex);
                const candidates = operationCandidates(nodes[firstIndex], nodes[secondIndex]);

                for (const candidate of candidates) {
                    const resultId = `result-${generatedNodeId++}`;
                    const resultLabel = formatNumber(candidate.result);
                    const step = {
                        leftId: candidate.left.id,
                        rightId: candidate.right.id,
                        resultId,
                        leftValue: candidate.left.value,
                        rightValue: candidate.right.value,
                        result: candidate.result,
                        operator: candidate.operator,
                        text: `${candidate.left.label} ${candidate.operator} ${candidate.right.label} = ${resultLabel}`
                    };
                    const resultNode = {
                        id: resultId,
                        value: candidate.result,
                        label: resultLabel
                    };

                    const found = dfs([...remaining, resultNode], [...steps, step]);
                    if (found) return found;
                }
            }
        }

        failedStates.add(stateKey);
        return null;
    }

    return dfs(initialNodes, []);
}

function checkSolution() {
    currentSolution = find24Solution(cards);
}

function startSolutionDemo() {
    if (!gameActive && !isAutoPlaying) {
        showMessage('请等待当前流程结束', 'info');
        return;
    }

    if (!currentSolution) {
        showMessage('这组牌无解', 'error');
        return;
    }

    resetCalculation(false);
    const solution = currentSolution;
    const version = gameVersion;

    isAutoPlaying = true;
    gameActive = false;
    calculationSteps = [];
    calculationDisplay.textContent = solution.map(step => step.text).join(' → ');
    calculationDisplay.style.color = '#665f4f';
    showMessage('开始自动演示答案...', 'success');

    setGameTimer(() => autoPlaySolution(solution, version), 500, version);
}

function autoPlaySolution(solution, version) {
    autoNodeToCardIndex = new Map(cards.map((card, index) => [card.id, index]));
    executeAutoPlayStep(solution, 0, version);
}

function executeAutoPlayStep(solution, stepIndex, version) {
    if (version !== gameVersion || !isAutoPlaying) return;

    if (stepIndex >= solution.length) {
        clearAutoHighlights();
        isAutoPlaying = false;
        gameActive = false;
        updateCalculationDisplay();
        showMessage('自动演示完成，可点击下一题或重置', 'success');
        return;
    }

    const step = solution[stepIndex];
    const card1Index = autoNodeToCardIndex.get(step.leftId);
    const card2Index = autoNodeToCardIndex.get(step.rightId);

    if (card1Index === undefined || card2Index === undefined || card1Index === card2Index) {
        clearAutoHighlights();
        isAutoPlaying = false;
        showMessage('答案演示状态异常，请重置', 'error');
        return;
    }

    cards[card1Index].element.classList.add('auto-highlight', 'selected');
    showMessage(`选中 ${getCardLabel(cards[card1Index])}`, 'info');

    setGameTimer(() => {
        const operatorButton = operatorButtons.find(button => button.dataset.operator === step.operator);
        if (operatorButton) operatorButton.classList.add('auto-highlight', 'selected');
        showMessage(`选择运算符 ${step.operator}`, 'info');

        setGameTimer(() => {
            cards[card2Index].element.classList.add('auto-highlight', 'selected');
            showMessage(`选中 ${getCardLabel(cards[card2Index])}`, 'info');

            setGameTimer(() => {
                performCalculationForAutoPlay(step, card1Index, card2Index);

                cards[card1Index].element.classList.remove('auto-highlight', 'selected');
                cards[card2Index].element.classList.remove('auto-highlight', 'selected');
                if (operatorButton) operatorButton.classList.remove('auto-highlight', 'selected');

                showMessage(`计算完成：${step.text}`, 'success');
                setGameTimer(() => executeAutoPlayStep(solution, stepIndex + 1, version), 900, version);
            }, 900, version);
        }, 700, version);
    }, 700, version);
}

function performCalculationForAutoPlay(step, index1, index2) {
    const card1 = cards[index1];
    const card2 = cards[index2];

    card1.used = true;
    card1.element.classList.add('used');

    card2.value = step.result;
    card2.isOriginal = false;
    const resultElement = card2.element.querySelector('.card-value');
    resultElement.textContent = formatNumber(step.result);
    resultElement.classList.toggle?.('long-value', resultElement.textContent.length >= 3);
    resultElement.classList.remove('result-pop');
    void resultElement.offsetWidth;
    resultElement.classList.add('result-pop');

    calculationSteps.push(step.text);
    updateCalculationDisplay();

    autoNodeToCardIndex.delete(step.leftId);
    autoNodeToCardIndex.delete(step.rightId);
    autoNodeToCardIndex.set(step.resultId, index2);
}

function resetCalculation(showResetMessage = false) {
    beginNewVersion();

    cards = cloneCards(initialCards);
    selectedCard = null;
    selectedOperator = null;
    calculationSteps = [];
    gameActive = true;
    isAutoPlaying = false;
    autoNodeToCardIndex = new Map();

    createCards();
    checkSolution();
    updateCalculationDisplay();
    if (showResetMessage) showMessage('已重置', 'info');
}

document.getElementById('solution-btn').addEventListener('click', startSolutionDemo);

document.getElementById('next-btn').addEventListener('click', () => {
    beginNewVersion();
    const version = gameVersion;
    gameActive = false;

    const marker = document.createElement('div');
    marker.className = 'dealing-animation';
    document.body.appendChild(marker);

    const cardElements = cards.map(card => card.element).filter(Boolean);
    const canAnimate = cardElements.length === 4
        && typeof cardElements[0].animate === 'function'
        && typeof cardElements[0].getBoundingClientRect === 'function';

    if (canAnimate) {
        const rects = cardElements.map(element => element.getBoundingClientRect());
        const centerX = rects.reduce((sum, rect) => sum + rect.left + rect.width / 2, 0) / rects.length;
        activeAnimations = cardElements.map((element, index) => {
            const rect = rects[index];
            const dx = centerX - (rect.left + rect.width / 2);
            return element.animate([
                { transform: 'translateX(0) rotate(0) scale(1)', opacity: 1 },
                { transform: `translateX(${dx}px) rotate(${(index - 1.5) * 1.5}deg) scale(.91)`, opacity: 0 }
            ], { duration: 350, easing: 'cubic-bezier(.55,0,.75,.25)', fill: 'forwards' });
        });
    }

    setGameTimer(() => {
        marker.remove();
        initGame();
    }, canAnimate ? 370 : 1, version);
});

document.getElementById('reset-btn').addEventListener('click', () => {
    resetCalculation(true);
});

document.getElementById('no-solution-btn').addEventListener('click', () => {
    if (!gameActive || isAutoPlaying) return;

    if (!currentSolution) {
        gameActive = false;
        solvedCount++;
        solvedCountEl.textContent = solvedCount;
        showMessage('判断正确，这组牌无解', 'success');
        setGameTimer(() => initGame(), 1500);
    } else {
        noSolutionButton.classList.remove('wobble');
        void noSolutionButton.offsetWidth;
        noSolutionButton.classList.add('wobble');
        setGameTimer(() => noSolutionButton.classList.remove('wobble'), 450);
        showMessage('这组牌有解，再试试', 'error');
    }
});

window.__gameDebug = {
    formatNumber,
    find24Solution,
    getState: () => ({
        cards: cards.map(card => ({
            id: card.id,
            value: card.value,
            suitIndex: card.suitIndex,
            used: card.used,
            isOriginal: card.isOriginal
        })),
        selectedCard,
        selectedOperator,
        calculationSteps: [...calculationSteps],
        solvedCount,
        gameActive,
        isAutoPlaying,
        currentSolution
    }),
    setCardsForTest: values => {
        beginNewVersion();
        cards = values.map((value, index) => ({
            id: `card-${index}`,
            value,
            suitIndex: index % SUITS.length,
            used: false,
            isOriginal: true,
            element: null
        }));
        initialCards = cloneCards(cards);
        createCards();
        gameActive = true;
        isAutoPlaying = false;
        calculationSteps = [];
        checkSolution();
        updateCalculationDisplay();
        return currentSolution;
    }
};

initGame();
