/**
 * Chess Arena v3 - Real Multiplayer
 */
const express = require('express');
const cors = require('cors');
const { Connection, PublicKey, Keypair, Transaction } = require('@solana/web3.js');
const { getAssociatedTokenAddress, createTransferInstruction, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const bs58 = require('bs58');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || '';
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const COMMISSION_RATE = 0.10;

const connection = new Connection(SOLANA_RPC, 'confirmed');
let wallet = null, WALLET_ADDRESS = '';

if (WALLET_PRIVATE_KEY) {
    try {
        wallet = Keypair.fromSecretKey(bs58.decode(WALLET_PRIVATE_KEY));
        WALLET_ADDRESS = wallet.publicKey.toString();
        console.log('✅ Wallet:', WALLET_ADDRESS);
    } catch (e) { console.error('Wallet error:', e.message); }
}

const rooms = new Map();
const processedTx = new Set();

const INIT_BOARD = [
    ['r','n','b','q','k','b','n','r'],
    ['p','p','p','p','p','p','p','p'],
    ['','','','','','','',''],
    ['','','','','','','',''],
    ['','','','','','','',''],
    ['','','','','','','',''],
    ['P','P','P','P','P','P','P','P'],
    ['R','N','B','Q','K','B','N','R']
];

function genCode() {
    const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 6; i++) s += c[Math.floor(Math.random() * c.length)];
    return s;
}

app.get('/api/config', (req, res) => {
    res.json({ walletAddress: WALLET_ADDRESS, usdcMint: USDC_MINT.toString(), commissionRate: COMMISSION_RATE });
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', walletAddress: WALLET_ADDRESS, rooms: rooms.size });
});

// Create room
app.post('/api/rooms', (req, res) => {
    const { entryFee, creatorName, creatorWallet } = req.body;
    const code = genCode();
    const room = {
        code, entryFee: parseFloat(entryFee) || 5, status: 'waiting_players',
        confirmedPayments: 0, board: INIT_BOARD.map(r => [...r]), currentTurn: 'white',
        lastMove: null, winner: null,
        players: [{ id: 0, name: creatorName || 'P1', wallet: creatorWallet, color: 'white', paid: false }]
    };
    rooms.set(code, room);
    console.log('Room created:', code);
    res.json({ success: true, room: { ...room, walletAddress: WALLET_ADDRESS } });
});

// Join room
app.post('/api/rooms/:code/join', (req, res) => {
    const room = rooms.get(req.params.code.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Not found' });
    if (room.players.length >= 2) return res.status(400).json({ error: 'Full' });
    
    room.players.push({ id: 1, name: req.body.playerName || 'P2', wallet: req.body.playerWallet, color: 'black', paid: false });
    room.status = 'waiting_payments';
    console.log('Player joined:', room.code);
    res.json({ success: true, room: { ...room, walletAddress: WALLET_ADDRESS } });
});

// Get room
app.get('/api/rooms/:code', (req, res) => {
    const room = rooms.get(req.params.code.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, room: { ...room, walletAddress: WALLET_ADDRESS } });
});

// Payment status
app.get('/api/rooms/:code/payments', (req, res) => {
    const room = rooms.get(req.params.code.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Not found' });
    res.json({
        success: true, status: room.status, confirmedPayments: room.confirmedPayments,
        canStartGame: room.confirmedPayments >= 2,
        players: room.players.map(p => ({ id: p.id, name: p.name, paymentConfirmed: p.paid }))
    });
});

// Game state (polling)
app.get('/api/rooms/:code/state', (req, res) => {
    const room = rooms.get(req.params.code.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Not found' });
    res.json({
        success: true, status: room.status, board: room.board, currentTurn: room.currentTurn,
        lastMove: room.lastMove, winner: room.winner,
        players: room.players.map(p => ({ id: p.id, name: p.name, color: p.color, paymentConfirmed: p.paid }))
    });
});

// Verify payment
app.post('/api/payments/verify', async (req, res) => {
    const { roomCode, txSignature, playerWallet } = req.body;
    const room = rooms.get(roomCode.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Not found' });
    if (room.status === 'finished') return res.status(400).json({ error: 'Game finished' });
    if (room.status === 'playing') return res.status(400).json({ error: 'Game already started' });
    if (processedTx.has(txSignature)) return res.status(400).json({ error: 'Already processed' });
    
    try {
        const tx = await connection.getTransaction(txSignature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
        if (!tx) return res.status(400).json({ error: 'TX not found' });
        if (tx.meta?.err) return res.status(400).json({ error: 'TX failed' });
        
        const player = room.players.find(p => !p.paid);
        if (!player) return res.status(400).json({ error: 'All paid' });
        
        player.paid = true;
        player.wallet = playerWallet;
        room.confirmedPayments++;
        processedTx.add(txSignature);
        
        // Start game only if 2 players AND 2 payments
        if (room.confirmedPayments >= 2 && room.players.length >= 2) {
            room.status = 'playing';
        }
        console.log('Payment verified:', roomCode, 'Player', player.id, 'Total paid:', room.confirmedPayments);
        
        let msg = 'Payment confirmed!';
        if (room.status === 'playing') msg = 'Game starting!';
        else if (room.players.length < 2) msg = 'Waiting for opponent to join...';
        else if (room.confirmedPayments < 2) msg = 'Waiting for opponent payment...';
        
        res.json({ success: true, room: { ...room, walletAddress: WALLET_ADDRESS }, message: msg });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Make move
app.post('/api/rooms/:code/move', (req, res) => {
    const { playerId, from, to } = req.body;
    const room = rooms.get(req.params.code.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Not found' });
    if (room.status !== 'playing') return res.status(400).json({ error: 'Not playing' });
    if (room.winner !== null) return res.status(400).json({ error: 'Game over' });
    
    const player = room.players[playerId];
    if (!player) return res.status(400).json({ error: 'Invalid player' });
    if (player.color !== room.currentTurn) return res.status(400).json({ error: 'Not your turn' });
    
    const piece = room.board[from.row][from.col];
    if (!piece) return res.status(400).json({ error: 'No piece' });
    
    const pieceColor = piece === piece.toUpperCase() ? 'white' : 'black';
    if (pieceColor !== player.color) return res.status(400).json({ error: 'Not your piece' });
    
    const target = room.board[to.row][to.col];
    const capturedKing = target?.toLowerCase() === 'k';
    
    room.board[to.row][to.col] = piece;
    room.board[from.row][from.col] = '';
    room.lastMove = { from, to };
    
    console.log('Move:', room.code, player.color, `${from.row},${from.col} -> ${to.row},${to.col}`);
    
    if (capturedKing) {
        room.winner = playerId;
        room.status = 'finished';
        console.log('Winner:', player.name);
        handlePayout(room);
        return res.json({ success: true, gameOver: true, winner: playerId, board: room.board });
    }
    
    room.currentTurn = room.currentTurn === 'white' ? 'black' : 'white';
    res.json({ success: true, board: room.board, currentTurn: room.currentTurn, lastMove: room.lastMove });
});

// End game manually
app.post('/api/rooms/:code/end', async (req, res) => {
    const room = rooms.get(req.params.code.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Not found' });
    room.winner = req.body.winnerId;
    room.status = 'finished';
    await handlePayout(room);
    res.json({ success: true, winner: room.players[room.winner]?.name });
});

async function handlePayout(room) {
    const winner = room.players[room.winner];
    if (!winner?.wallet || !wallet) return;
    
    const payout = room.entryFee * 2 * (1 - COMMISSION_RATE);
    try {
        const recipient = new PublicKey(winner.wallet);
        const senderATA = await getAssociatedTokenAddress(USDC_MINT, wallet.publicKey);
        const recipientATA = await getAssociatedTokenAddress(USDC_MINT, recipient);
        
        const ix = createTransferInstruction(senderATA, recipientATA, wallet.publicKey, Math.floor(payout * 1e6), [], TOKEN_PROGRAM_ID);
        const tx = new Transaction().add(ix);
        tx.feePayer = wallet.publicKey;
        tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        tx.sign(wallet);
        
        const sig = await connection.sendRawTransaction(tx.serialize());
        console.log('Payout sent:', payout, 'USDC, tx:', sig);
    } catch (e) {
        console.error('Payout error:', e.message);
    }
}

app.listen(PORT, () => console.log(`Chess Arena v3 on port ${PORT}`));
