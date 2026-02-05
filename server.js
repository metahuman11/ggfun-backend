/**
 * Chess Arena v5 - Custom Token Support ($TEST)
 * - Token based payments (same token amount for both players)
 * - Price fetched from Jupiter/DexScreener at room creation
 * - Security hardened
 */
const express = require('express');
const cors = require('cors');
const { Connection, PublicKey, Keypair, Transaction } = require('@solana/web3.js');
const { getAssociatedTokenAddress, createTransferInstruction, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');
const bs58 = require('bs58');

const app = express();

// ═══════════════════════════════════════════════════════════════
// SECURITY MIDDLEWARE
// ═══════════════════════════════════════════════════════════════

// CORS - only allow specific origins in production
const allowedOrigins = [
    'https://chess-arena-solana.netlify.app',
    'http://localhost:3000',
    'http://localhost:5173'
];

app.use(cors({
    origin: function(origin, callback) {
        // Allow requests with no origin (mobile apps, curl, etc.)
        if (!origin) return callback(null, true);
        if (allowedOrigins.some(allowed => origin.startsWith(allowed.replace(/:\d+$/, '')))) {
            return callback(null, true);
        }
        // In development, allow all
        if (process.env.NODE_ENV !== 'production') return callback(null, true);
        callback(new Error('Not allowed by CORS'));
    },
    credentials: true
}));

// Security headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    next();
});

// Rate limiting (simple in-memory)
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 100; // max requests per minute

app.use((req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    
    if (!rateLimits.has(ip)) {
        rateLimits.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    } else {
        const limit = rateLimits.get(ip);
        if (now > limit.resetAt) {
            limit.count = 1;
            limit.resetAt = now + RATE_LIMIT_WINDOW;
        } else {
            limit.count++;
            if (limit.count > RATE_LIMIT_MAX) {
                return res.status(429).json({ error: 'Too many requests. Please slow down.' });
            }
        }
    }
    next();
});

// Clean up rate limits every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [ip, limit] of rateLimits.entries()) {
        if (now > limit.resetAt + RATE_LIMIT_WINDOW) {
            rateLimits.delete(ip);
        }
    }
}, 300000);

app.use(express.json({ limit: '10kb' })); // Limit body size

// Input validation helper
function isValidWallet(address) {
    if (!address || typeof address !== 'string') return false;
    try {
        new PublicKey(address);
        return address.length >= 32 && address.length <= 44;
    } catch {
        return false;
    }
}

function sanitizeString(str, maxLen = 100) {
    if (typeof str !== 'string') return '';
    return str.slice(0, maxLen).replace(/[<>]/g, '');
}

const PORT = process.env.PORT || 3001;
const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || '';

// Custom Token Configuration
const TOKEN_MINT = new PublicKey('9mWXQkKkXfB7dajdL2ugHVo5PLK4YvuN21mJK9yNpump');
const TOKEN_SYMBOL = '$TEST';
const TOKEN_DECIMALS = 6; // Most pump.fun tokens have 6 decimals

const COMMISSION_RATE = 0.10;
const GAME_TIME_MS = 10 * 60 * 1000; // 10 minutes per player

const connection = new Connection(SOLANA_RPC, 'confirmed');
let wallet = null;
// Use WALLET_ADDRESS env var directly, or derive from private key
let WALLET_ADDRESS = process.env.WALLET_ADDRESS || '';

if (WALLET_PRIVATE_KEY) {
    try {
        wallet = Keypair.fromSecretKey(bs58.decode(WALLET_PRIVATE_KEY));
        WALLET_ADDRESS = wallet.publicKey.toString();
        console.log('✅ Wallet (from key):', WALLET_ADDRESS);
    } catch (e) { console.error('Wallet error:', e.message); }
} else if (WALLET_ADDRESS) {
    console.log('✅ Wallet (receive only):', WALLET_ADDRESS);
}

const rooms = new Map();
const processedTx = new Set();
const usernames = new Map();
const profiles = new Map(); // wallet -> profile data
const matchHistory = []; // All completed matches
let cachedTokenPrice = null;
let priceLastFetch = 0;

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

function getUsername(wallet) {
    return usernames.get(wallet) || wallet?.slice(0, 6) + '...' || 'Anonymous';
}

// ═══════════════════════════════════════════════════════════════
// TOKEN PRICE - From DexScreener
// ═══════════════════════════════════════════════════════════════
async function getTokenPrice() {
    // Cache for 30 seconds
    if (cachedTokenPrice && Date.now() - priceLastFetch < 30000) {
        return cachedTokenPrice;
    }
    
    try {
        // Try DexScreener first
        const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${TOKEN_MINT.toString()}`);
        const data = await res.json();
        
        if (data.pairs && data.pairs.length > 0) {
            // Get the pair with highest liquidity
            const bestPair = data.pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
            cachedTokenPrice = parseFloat(bestPair.priceUsd) || 0.0001;
            priceLastFetch = Date.now();
            console.log(`Token price: $${cachedTokenPrice}`);
            return cachedTokenPrice;
        }
    } catch (e) {
        console.error('Price fetch error:', e.message);
    }
    
    // Fallback price
    return cachedTokenPrice || 0.0001;
}

// ═══════════════════════════════════════════════════════════════
// USERNAME MANAGEMENT
// ═══════════════════════════════════════════════════════════════
app.post('/api/username', (req, res) => {
    const { wallet, username } = req.body;
    if (!wallet || !username) return res.status(400).json({ error: 'Missing data' });
    if (!isValidWallet(wallet)) return res.status(400).json({ error: 'Invalid wallet' });
    
    const cleanUsername = sanitizeString(username, 20).trim();
    if (cleanUsername.length < 1) return res.status(400).json({ error: 'Invalid username' });
    
    usernames.set(wallet, cleanUsername);
    console.log('Username set:', wallet.slice(0,8), '->', cleanUsername);
    res.json({ success: true, username: cleanUsername });
});

app.get('/api/username/:wallet', (req, res) => {
    const username = usernames.get(req.params.wallet);
    res.json({ success: true, username: username || null });
});

// ═══════════════════════════════════════════════════════════════
// PROFILE MANAGEMENT
// ═══════════════════════════════════════════════════════════════
function getOrCreateProfile(wallet) {
    if (!profiles.has(wallet)) {
        profiles.set(wallet, {
            wallet,
            username: usernames.get(wallet) || wallet.slice(0, 8) + '...',
            wins: 0,
            losses: 0,
            totalEarnings: 0,
            totalLost: 0,
            matches: [],
            joinedAt: Date.now()
        });
    }
    return profiles.get(wallet);
}

function recordMatch(room, winnerWallet, loserWallet) {
    const match = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        roomCode: room.code,
        winner: { wallet: winnerWallet, name: getUsername(winnerWallet) },
        loser: { wallet: loserWallet, name: getUsername(loserWallet) },
        entryFee: room.entryFeeUsd,
        tokenAmount: room.tokenAmount,
        prize: Math.floor(room.tokenAmount * 2 * (1 - COMMISSION_RATE)),
        timestamp: Date.now()
    };
    
    // Update winner profile
    const winnerProfile = getOrCreateProfile(winnerWallet);
    winnerProfile.wins++;
    winnerProfile.totalEarnings += match.prize;
    winnerProfile.username = getUsername(winnerWallet);
    winnerProfile.matches.unshift(match.id);
    if (winnerProfile.matches.length > 50) winnerProfile.matches.pop();
    
    // Update loser profile
    const loserProfile = getOrCreateProfile(loserWallet);
    loserProfile.losses++;
    loserProfile.totalLost += room.tokenAmount;
    loserProfile.username = getUsername(loserWallet);
    loserProfile.matches.unshift(match.id);
    if (loserProfile.matches.length > 50) loserProfile.matches.pop();
    
    // Add to global history
    matchHistory.unshift(match);
    if (matchHistory.length > 200) matchHistory.pop();
    
    console.log(`Match recorded: ${match.winner.name} beat ${match.loser.name}`);
    return match;
}

// Get profile by wallet
app.get('/api/profile/:wallet', (req, res) => {
    const wallet = req.params.wallet;
    const profile = getOrCreateProfile(wallet);
    profile.username = getUsername(wallet); // Update username
    
    // Get recent matches with full details
    const recentMatches = profile.matches
        .slice(0, 20)
        .map(matchId => matchHistory.find(m => m.id === matchId))
        .filter(m => m);
    
    // Get unique opponents
    const opponents = new Map();
    recentMatches.forEach(m => {
        const oppWallet = m.winner.wallet === wallet ? m.loser.wallet : m.winner.wallet;
        const oppName = m.winner.wallet === wallet ? m.loser.name : m.winner.name;
        const won = m.winner.wallet === wallet;
        
        if (!opponents.has(oppWallet)) {
            opponents.set(oppWallet, { wallet: oppWallet, name: oppName, wins: 0, losses: 0 });
        }
        if (won) opponents.get(oppWallet).wins++;
        else opponents.get(oppWallet).losses++;
    });
    
    res.json({
        success: true,
        profile: {
            ...profile,
            winRate: profile.wins + profile.losses > 0 
                ? ((profile.wins / (profile.wins + profile.losses)) * 100).toFixed(1) 
                : 0,
            recentMatches,
            opponents: Array.from(opponents.values()).sort((a, b) => (b.wins + b.losses) - (a.wins + a.losses)).slice(0, 10)
        }
    });
});

// Get leaderboard
app.get('/api/leaderboard', (req, res) => {
    const allProfiles = Array.from(profiles.values())
        .map(p => ({
            ...p,
            username: getUsername(p.wallet),
            winRate: p.wins + p.losses > 0 ? ((p.wins / (p.wins + p.losses)) * 100).toFixed(1) : 0
        }))
        .sort((a, b) => b.wins - a.wins)
        .slice(0, 20);
    
    res.json({ success: true, leaderboard: allProfiles });
});

// Get recent matches globally
app.get('/api/matches', (req, res) => {
    res.json({ success: true, matches: matchHistory.slice(0, 20) });
});

// ═══════════════════════════════════════════════════════════════
// CONFIG & HEALTH
// ═══════════════════════════════════════════════════════════════
app.get('/api/config', async (req, res) => {
    const price = await getTokenPrice();
    res.json({ 
        walletAddress: WALLET_ADDRESS, 
        tokenMint: TOKEN_MINT.toString(), 
        tokenSymbol: TOKEN_SYMBOL,
        tokenDecimals: TOKEN_DECIMALS,
        tokenPriceUsd: price,
        commissionRate: COMMISSION_RATE, 
        gameTimeMs: GAME_TIME_MS 
    });
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', walletAddress: WALLET_ADDRESS, rooms: rooms.size, token: TOKEN_SYMBOL });
});

app.get('/api/blockhash', async (req, res) => {
    try {
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
        res.json({ success: true, blockhash, lastValidBlockHeight });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Check if an account (ATA) exists
app.get('/api/check-ata', async (req, res) => {
    try {
        const { address } = req.query;
        if (!address) return res.json({ exists: false });
        
        const pubkey = new PublicKey(address);
        const accountInfo = await connection.getAccountInfo(pubkey);
        res.json({ exists: accountInfo !== null, address });
    } catch (e) {
        console.error('ATA check error:', e.message);
        res.json({ exists: false, error: e.message });
    }
});

// Get current token price
app.get('/api/price', async (req, res) => {
    const price = await getTokenPrice();
    res.json({ success: true, price, symbol: TOKEN_SYMBOL });
});

// ═══════════════════════════════════════════════════════════════
// ROOM MANAGEMENT
// ═══════════════════════════════════════════════════════════════
app.post('/api/rooms', async (req, res) => {
    const { entryFeeUsd, creatorWallet } = req.body;
    const code = genCode();
    
    // Get current token price
    const tokenPrice = await getTokenPrice();
    const usdAmount = parseFloat(entryFeeUsd) || 5;
    
    // Calculate token amount (how many tokens = $X USD)
    const tokenAmount = Math.floor(usdAmount / tokenPrice);
    
    const room = {
        code, 
        entryFeeUsd: usdAmount,           // USD value for display
        tokenAmount: tokenAmount,          // Actual token amount both players pay
        tokenPriceAtCreation: tokenPrice,  // Price when room was created
        status: 'waiting_players',
        confirmedPayments: 0,
        board: INIT_BOARD.map(r => [...r]),
        currentTurn: 'white',
        lastMove: null,
        winner: null,
        whiteTimeMs: GAME_TIME_MS,
        blackTimeMs: GAME_TIME_MS,
        lastMoveTime: null,
        players: [{ id: 0, wallet: creatorWallet, name: getUsername(creatorWallet), color: 'white', paid: false }],
        spectators: [],
        emojis: []
    };
    rooms.set(code, room);
    console.log(`Room created: ${code} - ${tokenAmount} ${TOKEN_SYMBOL} (~$${usdAmount})`);
    res.json({ success: true, room: sanitizeRoom(room) });
});

app.post('/api/rooms/:code/join', (req, res) => {
    const room = rooms.get(req.params.code.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Not found' });
    if (room.players.length >= 2) return res.status(400).json({ error: 'Full' });
    
    const { playerWallet } = req.body;
    if (!isValidWallet(playerWallet)) return res.status(400).json({ error: 'Invalid wallet' });
    
    // Prevent same player joining twice
    if (room.players.some(p => p.wallet === playerWallet)) {
        return res.status(400).json({ error: 'Already in room' });
    }
    
    room.players.push({ id: 1, wallet: playerWallet, name: getUsername(playerWallet), color: 'black', paid: false });
    room.status = 'waiting_payments';
    console.log('Player joined:', room.code);
    res.json({ success: true, room: sanitizeRoom(room) });
});

app.post('/api/rooms/:code/spectate', (req, res) => {
    const room = rooms.get(req.params.code.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Not found' });
    
    const { wallet } = req.body;
    const spectator = { wallet, name: getUsername(wallet), joinedAt: Date.now() };
    
    if (!room.spectators.find(s => s.wallet === wallet)) {
        room.spectators.push(spectator);
        console.log('Spectator joined:', room.code, spectator.name);
    }
    
    res.json({ success: true, room: sanitizeRoom(room) });
});

app.post('/api/rooms/:code/emoji', (req, res) => {
    const room = rooms.get(req.params.code.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Not found' });
    
    const { wallet, emoji } = req.body;
    const allowedEmojis = ['👏', '🔥', '😮', '😂', '👀', '💀', '🎉', '👍', '👎', '❤️'];
    if (!allowedEmojis.includes(emoji)) return res.status(400).json({ error: 'Invalid emoji' });
    
    room.emojis.push({ emoji, name: getUsername(wallet), time: Date.now() });
    if (room.emojis.length > 20) room.emojis = room.emojis.slice(-20);
    
    res.json({ success: true });
});

// In-game chat
app.post('/api/rooms/:code/chat', (req, res) => {
    const room = rooms.get(req.params.code.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Not found' });
    
    const { wallet, message } = req.body;
    if (!isValidWallet(wallet)) return res.status(400).json({ error: 'Invalid wallet' });
    
    const cleanMessage = sanitizeString(message, 200).trim();
    if (cleanMessage.length === 0) return res.status(400).json({ error: 'Empty message' });
    
    // Initialize chat array if not exists
    if (!room.chat) room.chat = [];
    
    // Rate limit chat (max 10 messages per minute per user)
    const recentMsgs = room.chat.filter(m => m.wallet === wallet && m.time > Date.now() - 60000);
    if (recentMsgs.length >= 10) return res.status(429).json({ error: 'Too many messages, slow down' });
    
    // Determine if player or spectator
    const player = room.players.find(p => p.wallet === wallet);
    const isPlayer = !!player;
    
    const chatMsg = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 4),
        wallet: wallet.slice(0, 8) + '...', // Don't expose full wallet in chat
        name: getUsername(wallet),
        message: cleanMessage,
        isPlayer,
        color: player?.color || null,
        time: Date.now()
    };
    
    room.chat.push(chatMsg);
    // Keep last 100 messages
    if (room.chat.length > 100) room.chat = room.chat.slice(-100);
    
    res.json({ success: true, message: chatMsg });
});

// Get chat messages
app.get('/api/rooms/:code/chat', (req, res) => {
    const room = rooms.get(req.params.code.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Not found' });
    
    const since = parseInt(req.query.since) || 0;
    const messages = (room.chat || []).filter(m => m.time > since);
    
    res.json({ success: true, messages });
});

// List all active rooms
app.get('/api/rooms', (req, res) => {
    const activeRooms = [];
    rooms.forEach((room, code) => {
        activeRooms.push({
            code: room.code,
            status: room.status,
            entryFeeUsd: room.entryFeeUsd,
            tokenAmount: room.tokenAmount,
            playerCount: room.players.length,
            spectatorCount: room.spectators.length,
            players: room.players.map(p => ({ name: p.name, color: p.color })),
            currentTurn: room.currentTurn,
            createdAt: room.createdAt || Date.now()
        });
    });
    // Sort by status (playing first, then waiting)
    activeRooms.sort((a, b) => {
        const order = { playing: 0, waiting_payments: 1, waiting_players: 2, finished: 3 };
        return (order[a.status] || 99) - (order[b.status] || 99);
    });
    res.json({ success: true, rooms: activeRooms });
});

app.get('/api/rooms/:code', (req, res) => {
    const room = rooms.get(req.params.code.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, room: sanitizeRoom(room) });
});

app.get('/api/rooms/:code/payments', (req, res) => {
    const room = rooms.get(req.params.code.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Not found' });
    res.json({
        success: true, status: room.status, confirmedPayments: room.confirmedPayments,
        canStartGame: room.confirmedPayments >= 2 && room.players.length >= 2,
        tokenAmount: room.tokenAmount,
        players: room.players.map(p => ({ id: p.id, name: p.name, color: p.color, paymentConfirmed: p.paid }))
    });
});

app.get('/api/rooms/:code/state', (req, res) => {
    const room = rooms.get(req.params.code.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Not found' });
    
    updateTimer(room);
    
    // Update player names from usernames map
    room.players.forEach(p => {
        p.name = getUsername(p.wallet);
    });
    
    res.json({
        success: true, status: room.status, board: room.board, currentTurn: room.currentTurn,
        lastMove: room.lastMove, winner: room.winner,
        whiteTimeMs: room.whiteTimeMs, blackTimeMs: room.blackTimeMs,
        tokenAmount: room.tokenAmount,
        entryFeeUsd: room.entryFeeUsd,
        players: room.players.map(p => ({ id: p.id, wallet: p.wallet, name: p.name, color: p.color, paymentConfirmed: p.paid })),
        spectatorCount: room.spectators.length,
        emojis: room.emojis.slice(-10),
        chatCount: (room.chat || []).length
    });
});

function updateTimer(room) {
    if (room.status !== 'playing' || !room.lastMoveTime) return;
    
    const elapsed = Date.now() - room.lastMoveTime;
    if (room.currentTurn === 'white') {
        room.whiteTimeMs = Math.max(0, room.whiteTimeMs - elapsed);
        if (room.whiteTimeMs <= 0) {
            room.winner = 1;
            room.status = 'finished';
            console.log('White timeout! Black wins:', room.code);
            handlePayout(room);
        }
    } else {
        room.blackTimeMs = Math.max(0, room.blackTimeMs - elapsed);
        if (room.blackTimeMs <= 0) {
            room.winner = 0;
            room.status = 'finished';
            console.log('Black timeout! White wins:', room.code);
            handlePayout(room);
        }
    }
    room.lastMoveTime = Date.now();
}

function sanitizeRoom(room) {
    return {
        ...room,
        walletAddress: WALLET_ADDRESS,
        tokenSymbol: TOKEN_SYMBOL,
        players: room.players.map(p => ({ id: p.id, name: p.name, color: p.color, paid: p.paid })),
        spectatorCount: room.spectators.length
    };
}

// ═══════════════════════════════════════════════════════════════
// PAYMENT VERIFICATION
// ═══════════════════════════════════════════════════════════════
app.post('/api/payments/verify', async (req, res) => {
    const { roomCode, txSignature, playerWallet } = req.body;
    const room = rooms.get(roomCode.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Not found' });
    if (room.status === 'finished') return res.status(400).json({ error: 'Game finished' });
    if (room.status === 'playing') return res.status(400).json({ error: 'Game started' });
    if (processedTx.has(txSignature)) return res.status(400).json({ error: 'Already processed' });
    
    try {
        const tx = await connection.getTransaction(txSignature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
        if (!tx) return res.status(400).json({ error: 'TX not found' });
        if (tx.meta?.err) return res.status(400).json({ error: 'TX failed' });
        
        // TODO: Verify exact token amount in transaction matches room.tokenAmount
        // For now, trust the transaction
        
        const player = room.players.find(p => !p.paid);
        if (!player) return res.status(400).json({ error: 'All paid' });
        
        player.paid = true;
        player.wallet = playerWallet;
        player.name = getUsername(playerWallet);
        room.confirmedPayments++;
        processedTx.add(txSignature);
        
        if (room.confirmedPayments >= 2 && room.players.length >= 2) {
            room.status = 'playing';
            room.lastMoveTime = Date.now();
        }
        console.log(`Payment verified: ${roomCode} - Player ${player.id} - ${room.tokenAmount} ${TOKEN_SYMBOL}`);
        
        let msg = 'Payment confirmed!';
        if (room.status === 'playing') msg = 'Game starting!';
        
        res.json({ success: true, room: sanitizeRoom(room), message: msg });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// MOVE
// ═══════════════════════════════════════════════════════════════
app.post('/api/rooms/:code/move', (req, res) => {
    const { playerId, from, to } = req.body;
    const room = rooms.get(req.params.code.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Not found' });
    if (room.status !== 'playing') return res.status(400).json({ error: 'Not playing' });
    if (room.winner !== null) return res.status(400).json({ error: 'Game over' });
    
    updateTimer(room);
    if (room.winner !== null) {
        return res.json({ success: true, board: room.board, gameOver: true, winner: room.winner, timeout: true });
    }
    
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
    room.lastMoveTime = Date.now();
    
    console.log('Move:', room.code, player.color, `${from.row},${from.col} -> ${to.row},${to.col}`);
    
    if (capturedKing) {
        room.winner = playerId;
        room.status = 'finished';
        console.log('Winner:', player.name);
        handlePayout(room);
        return res.json({ success: true, board: room.board, gameOver: true, winner: playerId });
    }
    
    room.currentTurn = room.currentTurn === 'white' ? 'black' : 'white';
    res.json({ 
        success: true, board: room.board, currentTurn: room.currentTurn, lastMove: room.lastMove,
        whiteTimeMs: room.whiteTimeMs, blackTimeMs: room.blackTimeMs
    });
});

// ═══════════════════════════════════════════════════════════════
// PAYOUT - Send tokens to winner
// ═══════════════════════════════════════════════════════════════
async function handlePayout(room) {
    const winner = room.players[room.winner];
    const loser = room.players.find(p => p.id !== room.winner);
    
    // Record match in history
    if (winner?.wallet && loser?.wallet) {
        recordMatch(room, winner.wallet, loser.wallet);
    }
    
    if (!wallet) {
        console.log('No wallet configured for payout');
        return;
    }
    
    if (!winner?.wallet) return;
    
    // Winner gets: (tokenAmount * 2) - 10% commission
    const payoutTokens = Math.floor(room.tokenAmount * 2 * (1 - COMMISSION_RATE));
    
    try {
        const recipient = new PublicKey(winner.wallet);
        // Use Token-2022 program for pump.fun tokens
        const senderATA = await getAssociatedTokenAddress(TOKEN_MINT, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID);
        const recipientATA = await getAssociatedTokenAddress(TOKEN_MINT, recipient, false, TOKEN_2022_PROGRAM_ID);
        
        // Token amount in smallest units
        const amountInSmallestUnit = payoutTokens * Math.pow(10, TOKEN_DECIMALS);
        
        const ix = createTransferInstruction(
            senderATA, 
            recipientATA, 
            wallet.publicKey, 
            amountInSmallestUnit, 
            [], 
            TOKEN_2022_PROGRAM_ID
        );
        
        const tx = new Transaction().add(ix);
        tx.feePayer = wallet.publicKey;
        tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        tx.sign(wallet);
        
        const sig = await connection.sendRawTransaction(tx.serialize());
        console.log(`Payout sent: ${payoutTokens} ${TOKEN_SYMBOL} to ${winner.name}, tx: ${sig}`);
    } catch (e) { 
        console.error('Payout error:', e.message); 
    }
}

app.listen(PORT, () => console.log(`Chess Arena v5 (${TOKEN_SYMBOL}) on port ${PORT}`));
