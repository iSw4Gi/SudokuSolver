// ==UserScript==
// @name         Sudoku Solver (Full)
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  Solve Sudoku from JS variables, API using cookies, or OCR; show step-by-step solution.
// @author       Nader Alharbi
// @match        https://sudoku.com/*
// @grant        none
// @require      https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/4.1.1/tesseract.min.js
// ==/UserScript==

(function() {
    'use strict';

    let canvas;
    let originalGrid;

    // ------------------- BUTTON -------------------
    function addSolveButton() {
        if (document.getElementById('tmSolveButton')) return;
        const btn = document.createElement('button');
        btn.id = 'tmSolveButton';
        btn.innerText = 'Solve Sudoku';
        btn.style.position = 'fixed';
        btn.style.bottom = '20px';
        btn.style.right = '20px';
        btn.style.padding = '10px 16px';
        btn.style.backgroundColor = '#4caf50';
        btn.style.color = '#fff';
        btn.style.border = 'none';
        btn.style.borderRadius = '6px';
        btn.style.cursor = 'pointer';
        btn.style.zIndex = 9999;
        btn.style.boxShadow = '0 2px 6px rgba(0,0,0,0.2)';
        btn.addEventListener('mouseover', () => btn.style.backgroundColor = '#45a049');
        btn.addEventListener('mouseout', () => btn.style.backgroundColor = '#4caf50');
        btn.addEventListener('click', () => waitForCanvas());
        document.body.appendChild(btn);
    }

    addSolveButton();

    // ------------------- CANVAS WAIT -------------------
    function waitForCanvas() {
        canvas = document.querySelector('#game canvas');
        if (canvas) {
            console.log('Canvas found. Starting extraction...');
            extractAndSolve();
        } else {
            console.log('Waiting for canvas...');
            setTimeout(waitForCanvas, 1200);
        }
    }

    // ------------------- GRID EXTRACTION -------------------
    async function extractAndSolve() {
        let grid = extractFromJS();
        let solution = null;

        if (!grid) {
            console.log('JS variable extraction failed. Trying API with cookies...');
            const apiData = await extractFromAPIUsingCookies();
            if (apiData) {
                grid = apiData.puzzleGrid;
                solution = apiData.solutionGrid;
            }
        }

        if (!grid) {
            console.log('API extraction failed. Falling back to OCR...');
            grid = await extractFromPixels();
        }

        if (!grid) {
            console.error('Extraction failed. Provide manual grid with manualSolve(grid).');
            return;
        }

        originalGrid = JSON.parse(JSON.stringify(grid));
        const result = await solveSudokuWithSteps(grid);
        showSolutionInNewTab(originalGrid, result.solvedGrid, result.steps, result.truncated);
    }

    // --- JS VARIABLE EXTRACTION ---
    function extractFromJS() {
        const varsToTry = ['window.sudokuBoard','window.board','window.puzzle','window.grid','window.currentPuzzle','window.gameBoard'];
        for (let v of varsToTry) {
            try {
                const obj = eval(v);
                if (obj && Array.isArray(obj) && obj.length===9 && Array.isArray(obj[0]) && obj[0].length===9) {
                    return obj.map(row => row.map(cell => parseInt(cell)||0));
                }
            } catch(e){}
        }
        return null;
    }

    // --- API EXTRACTION USING COOKIES ---
    async function extractFromAPIUsingCookies() {
        console.log('🔍 Attempting API extraction with cookies...');
        const urlParams = new URLSearchParams(window.location.search);
        // Find the currently selected difficulty button
        const difficultyButtons = document.querySelectorAll(".ref-start-game_items a");
        let level = 'medium'; // fallback

        difficultyButtons.forEach(btn => {
            if (btn.classList.contains('active')) { // active button has 'active' class
                level = btn.innerText.trim().toLowerCase(); // e.g., "Easy", "Medium", "Hard"
            }
        });

        console.log('Detected level:', level);
        const endpoint = `/api/v2/level/${level}`;

        try {
            const resp = await fetch(endpoint, {
                method:'GET',
                credentials:'include',
                headers:{
                    'Accept':'application/json, text/javascript, */*; q=0.01',
                    'X-Requested-With':'XMLHttpRequest',
                    'Referer': window.location.href,
                    'Cache-Control': 'no-cache'
                }
            });
            if(!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            let mission = data.mission || data.puzzle || data.grid;
            let solution = data.solution || data.answer;
            if(!mission || mission.length!==81) throw new Error('Invalid puzzle');

            if(typeof mission==='string') mission=mission.split('');
            if(typeof solution==='string') solution=solution.split('');

            const puzzleGrid=[], solutionGrid=[];
            for(let i=0;i<81;i++){
                const r=Math.floor(i/9), c=i%9;
                if(!puzzleGrid[r]) puzzleGrid[r]=[];
                if(!solutionGrid[r]) solutionGrid[r]=[];
                puzzleGrid[r][c]=parseInt(mission[i])||0;
                solutionGrid[r][c]=solution ? parseInt(solution[i])||0 : 0;
            }
            console.log('✅ API puzzle grid:', puzzleGrid);
            return {puzzleGrid, solutionGrid};
        } catch(err){
            console.error('💥 API fetch failed:', err);
            return null;
        }
    }

    // --- PIXEL EXTRACTION (OCR) ---
    async function extractFromPixels() {
        if(!canvas) return null;
        const ctx = canvas.getContext('2d');
        const grid=Array(9).fill().map(()=>Array(9).fill(0));
        const w=canvas.width/9, h=canvas.height/9;

        for(let r=0;r<9;r++){
            for(let c=0;c<9;c++){
                const tmpCanvas=document.createElement('canvas');
                tmpCanvas.width=w; tmpCanvas.height=h;
                const tmpCtx=tmpCanvas.getContext('2d');
                tmpCtx.drawImage(canvas, c*w, r*h, w, h, 0,0,w,h);
                if(typeof Tesseract!=='undefined'){
                    try{
                        const {data:{text}}=await Tesseract.recognize(tmpCanvas,'eng',{tessedit_char_whitelist:'123456789'});
                        const d=parseInt(text.trim());
                        if(!isNaN(d) && d>=1 && d<=9) grid[r][c]=d;
                    }catch(e){ grid[r][c]=0; }
                }
            }
        }
        console.log('✅ Pixel OCR grid:', grid);
        return grid;
    }

    // --- SUDOKU SOLVER WITH STEP LOG ---
    async function solveSudokuWithSteps(inputGrid) {
        const grid=inputGrid.map(r=>r.slice());
        const steps=[], LOG_LIMIT=2000;
        let logging=true, truncated=false;

        const gridStr=g=>g.map(r=>r.map(v=>v?v:'.').join(' ')).join('\n');

        const candidates=(g,row,col)=>{
            if(g[row][col]) return [];
            const used=new Set();
            for(let i=0;i<9;i++){ if(g[row][i]) used.add(g[row][i]); if(g[i][col]) used.add(g[i][col]); }
            const sr=row-row%3, sc=col-col%3;
            for(let i=0;i<3;i++) for(let j=0;j<3;j++) if(g[sr+i][sc+j]) used.add(g[sr+i][sc+j]);
            return [...Array(9).keys()].map(x=>x+1).filter(n=>!used.has(n));
        };

        const findEmpty=g=>{
            let best=null;
            for(let r=0;r<9;r++){
                for(let c=0;c<9;c++){
                    if(g[r][c]===0){
                        const cands=candidates(g,r,c);
                        if(!best||cands.length<best.cands.length) best={row:r,col:c,cands};
                        if(cands.length===1) return best;
                    }
                }
            }
            return best;
        };

        const pushStep=obj=>{
            if(!logging) return;
            steps.push(obj);
            if(steps.length>LOG_LIMIT){ logging=false; truncated=true; steps.push({type:'info',message:`Step log exceeded ${LOG_LIMIT} entries.`}); }
        };

        async function backtrack(){
            const cell=findEmpty(grid);
            if(!cell) return true;
            const {row,col,cands}=cell;
            if(cands.length===0){ pushStep({type:'deadend',row,col,before:gridStr(grid)}); return false; }

            for(const num of cands){
                pushStep({type:'place',row,col,num,candidates:cands.slice(),reason:cands.length===1?'forced':'trial',before:gridStr(grid)});
                grid[row][col]=num;
                await new Promise(r=>setTimeout(r,0));
                if(await backtrack()){ pushStep({type:'confirm',row,col,num,after:gridStr(grid)}); return true; }
                grid[row][col]=0;
                pushStep({type:'remove',row,col,num,reason:'backtrack',after:gridStr(grid)});
                await new Promise(r=>setTimeout(r,0));
            }
            return false;
        }

        const success=await backtrack();
        return {success, solvedGrid:grid, steps, truncated};
    }

    function showSolutionInNewTab(original, solved, steps, truncated){
        const win = window.open('', '_blank');
        if(!win){ alert('Popup blocked'); return; }

        const gridHtml = g => {
            let html = '<table class="sudoku">';
            for(let r = 0; r < 9; r++){
                html += '<tr>';
                for(let c = 0; c < 9; c++){
                    const isGiven = original && original[r][c] !== 0;
                    html += `<td class="${isGiven?'given':'solved'}">${g[r][c] || ''}</td>`;
                }
                html += '</tr>';
            }
            html += '</table>';
            return html;
        };

        let stepsHtml = '<ol class="steps">';
        for(let i = 0; i < steps.length; i++){
            const s = steps[i], r = (s.row !== undefined ? s.row + 1 : null), c = (s.col !== undefined ? s.col + 1 : null);
            let entry = '';
            if(s.type === 'place') entry = `<strong>Step ${i+1} — Place</strong>: Put <b>${s.num}</b> at (R${r},C${c})<br>Candidates: [${s.candidates.join(', ')}]<br>Reason: ${s.reason}<pre>${s.before}</pre>`;
            else if(s.type === 'remove') entry = `<strong>Step ${i+1} — Remove</strong>: Removed <b>${s.num}</b> at (R${r},C${c})<br>${s.after ? `<pre>${s.after}</pre>` : ''}`;
            else if(s.type === 'confirm') entry = `<strong>Step ${i+1} — Confirm</strong>: <b>${s.num}</b> at (R${r},C${c}) confirmed<br>${s.after ? `<pre>${s.after}</pre>` : ''}`;
            else if(s.type === 'deadend') entry = `<strong>Deadend</strong> at (R${r},C${c})<pre>${s.before}</pre>`;
            else if(s.type === 'info') entry = `<strong>Info:</strong> ${s.message}`;
            else entry = `<strong>Step ${i+1}</strong>: ${JSON.stringify(s)}`;
            stepsHtml += `<li class="step-entry">${entry}</li>`;
        }
        stepsHtml += '</ol>';
        const truncatedNote = truncated ? '<p class="warning">Step log truncated.</p>' : '';

        const html = `
    <html>
    <head>
        <title>Sudoku Solution</title>
        <meta charset="utf-8"/>
        <style>
            body { font-family: 'Segoe UI', Tahoma, sans-serif; background: #f4f6f8; padding: 20px; color: #222; }
            h1 { text-align: center; color: #2c3e50; }
            h2 { margin-top: 30px; color: #34495e; }
            .container { display: flex; gap: 40px; justify-content: center; flex-wrap: wrap; margin-bottom: 20px; }
            .panel { background: #fff; padding: 20px; border-radius: 10px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
            table.sudoku { border-collapse: collapse; }
            table.sudoku td { width: 40px; height: 40px; text-align: center; vertical-align: middle; border: 1px solid #ccc; font-size: 20px; transition: all 0.2s; }
            td.given { background: #ecf0f1; font-weight: bold; color: #2c3e50; }
            td.solved { color: #e74c3c; font-weight: bold; }
            td:hover { background: #d1d8e0; cursor: default; }
            pre { background: #1e1e1e; color: #f1f1f1; padding: 8px; border-radius: 6px; overflow: auto; font-size: 13px; }
            .steps { padding-left: 20px; }
            .step-entry { margin-bottom: 12px; padding: 10px; background: #fff; border-left: 4px solid #3498db; border-radius: 6px; box-shadow: 0 2px 6px rgba(0,0,0,0.05); transition: transform 0.2s; }
            .step-entry:hover { transform: translateX(5px); background: #f9f9f9; }
            .warning { color: #c0392b; font-weight: bold; margin-top: 15px; }
            button { padding: 10px 14px; border-radius: 8px; border: none; background: #3498db; color: #fff; cursor: pointer; transition: background 0.2s; margin-bottom: 20px; }
            button:hover { background: #2980b9; }
        </style>
    </head>
    <body>
        <h1>Sudoku — Step-by-Step Solution</h1>
        <div class="controls" style="text-align:center;">
            <button id="downloadJson">Download steps (JSON)</button>
        </div>
        <div class="container">
            <div class="panel">
                <h3>Original Puzzle</h3>
                ${gridHtml(original)}
            </div>
            <div class="panel">
                <h3>Solved Puzzle</h3>
                ${gridHtml(solved)}
            </div>
        </div>
        ${truncatedNote}
        <h2>Step-by-step Log (${steps.length} entries)</h2>
        <div class="panel">
            ${stepsHtml}
        </div>
        <script>
            const stepsData = ${JSON.stringify(steps)};
            document.getElementById('downloadJson').addEventListener('click', function() {
                const blob = new Blob([JSON.stringify(stepsData, null, 2)], {type:'application/json'});
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'sudoku_steps.json';
                a.click();
                URL.revokeObjectURL(url);
            });
        </script>
    </body>
    </html>
    `;

        win.document.open();
        win.document.write(html);
        win.document.close();
    }

    // --- MANUAL SOLVE ---
    window.manualSolve=function(testGrid){
        if(!Array.isArray(testGrid)||testGrid.length!==9){ console.error('Grid must be 9x9'); return; }
        originalGrid=JSON.parse(JSON.stringify(testGrid));
        solveSudokuWithSteps(testGrid).then(result=>{
            showSolutionInNewTab(originalGrid,result.solvedGrid,result.steps,result.truncated);
        });
    };

})();
