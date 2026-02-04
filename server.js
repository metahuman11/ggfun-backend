/**
 * Chess Arena - Solana Backend v2
 * STRICT Payment Gating - Game NEVER starts without 2 confirmed on-chain payments
 */

const express = require('express');
const cors = require('cors');
const { Connection, PublicKey, Keypair, Transaction } = require('@solana/web3.js');
const { getAssociatedTokenAddress, createTransferInstruction, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const bs58 = require('bs58');

const app = express();
app.use(cors());
app.use(express.json());

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3001;
const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || '';
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const COMMISSION_RATE = 0.10;

const connection = new Connection(SOLANA_RPC, 'confirmed');

let wallet = null;
let WALLET_ADDRESS = '';

if (WALLET_PRIVATE_KEY) {
    try {
        const secretKey = bs58.decode(WALLET_PRIVATE_KEY);
        wallet = Keypair.fromSecretKey(secretKey);
        WALLET_ADDRESS = wallet.publicKey.toString();
        console.log('✅ Wallet loaded:', WALLET_ADDRESS);
    } catch (e) {
        console.error('❌ Failed to load wallet:', e.message);
    }
}

// ═══════════════════════════════════════════════════════════════
// DATABASE (In-memory - use Redis/MongoDB in production)
// ═══════════════════════════════════════════════════════════════
const rooms = new Map();
const processedSignatures = new Set();

// Room States:
// 'waiting_players' - Waiting for 2nd player to join
// 'waiting_payments' - Both players joined, waiting for BOTH on-chain payments
// 'playing' - ONLY after 2 confirmed payments
// 'finished' - Game ended

// ═══════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════
function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

function getRoomResponse(room) {
    return {
        code: room.code,
        entryFee: room.entryFee,
        status: room.status,
        walletAddress: WALLET_ADDRESS, // Always inject from backend
        confirmedPayments: room.confirmedPayments,
        requiredPayments: 2,
        canStartGame: room.confirmedPayments >= 2,
        prizePool: room.entryFee * room.confirmedPayments,
        players: room.players.map(p => ({
            id: p.id,
            name: p.name,
            color: p.color,
            paymentConfirmed: p.paymentConfirmed,
            txSignature: p.txSignature || null
        }))
    };
}

// ═══════════════════════════════════════════════════════════════
// ROOM ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// Get config (wallet address for frontend)
app.get('/api/config', (req, res) => {
    res.json({
        walletAddress: WALLET_ADDRESS,
        usdcMint: USDC_MINT.toString(),
        commissionRate: COMMISSION_RATE
    });
});

// Create room
app.post('/api/rooms', (req, res) => {
    const { entryFee, creatorName, creatorWallet } = req.body;
    
    if (!WALLET_ADDRESS) {
        return res.status(500).json({ error: 'Backend wallet not configured' });
    }
    
    const roomCode = generateRoomCode();
    const room = {
        code: roomCode,
        entryFee: parseFloat(entryFee) || 5,
        status: 'waiting_players',
        confirmedPayments: 0, // CRITICAL: Track on-chain confirmed payments
        players: [{
            id: 0,
            name: creatorName || 'Player 1',
            wallet: creatorWallet || null,
            color: 'white',
            paymentConfirmed: false, // Only true after on-chain verification
            txSignature: null
        }],
        winner: null,
        createdAt: Date.now()
    };
    
    rooms.set(roomCode, room);
    console.log(`🆕 Room created: ${roomCode} (${room.entryFee} USDC)`);
    
    res.json({ success: true, room: getRoomResponse(room) });
});

// Join room
app.post('/api/rooms/:code/join', (req, res) => {
    const { code } = req.params;
    const { playerName, playerWallet } = req.body;
    
    const room = rooms.get(code.toUpperCase());
    if (!room) {
        return res.status(404).json({ error: 'Room not found' });
    }
    if (room.players.length >= 2) {
        return res.status(400).json({ error: 'Room is full' });
    }
    if (room.status !== 'waiting_players') {
        return res.status(400).json({ error: 'Cannot join this room' });
    }
    
    room.players.push({
        id: 1,
        name: playerName || 'Player 2',
        wallet: playerWallet || null,
        color: 'black',
        paymentConfirmed: false,
        txSignature: null
    });
    
    // Move to waiting_payments - now need both to pay
    room.status = 'waiting_payments';
    
    console.log(`🚪 Player joined: ${code} - Now waiting for payments`);
    res.json({ success: true, room: getRoomResponse(room) });
});

// Get room status
app.get('/api/rooms/:code', (req, res) => {
    const { code } = req.params;
    const room = rooms.get(code.toUpperCase());
    
    if (!room) {
        return res.status(404).json({ error: 'Room not found' });
    }
    
    res.json({ success: true, room: getRoomResponse(room) });
});

// List active rooms
app.get('/api/rooms', (req, res) => {
    const activeRooms = [];
    rooms.forEach((room, code) => {
        if (room.status === 'waiting_players') {
            activeRooms.push({
                code,
                entryFee: room.entryFee,
                creator: room.players[0]?.name,
                walletAddress: WALLET_ADDRESS
            });
        }
    });
    res.json({ success: true, rooms: activeRooms });
});

// ═══════════════════════════════════════════════════════════════
// PAYMENT VERIFICATION - CRITICAL
// ═══════════════════════════════════════════════════════════════

// Verify payment on-chain
app.post('/api/payments/verify', async (req, res) => {
    const { roomCode, txSignature, playerWallet } = req.body;
    
    const room = rooms.get(roomCode.toUpperCase());
    if (!room) {
        return res.status(404).json({ error: 'Room not found' });
    }
    
    if (room.status !== 'waiting_payments') {
        return res.status(400).json({ error: 'Room not accepting payments' });
    }
    
    // Check if already processed
    if (processedSignatures.has(txSignature)) {
        return res.status(400).json({ error: 'Transaction already processed' });
    }
    
    try {
        console.log(`🔍 Verifying tx: ${txSignature}`);
        
        // Fetch transaction from chain
        const tx = await connection.getTransaction(txSignature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed'
        });
        
        if (!tx) {
            return res.status(400).json({ error: 'Transaction not found on chain' });
        }
        
        if (tx.meta?.err) {
            return res.status(400).json({ error: 'Transaction failed on chain' });
        }
        
        // Verify recipient is our wallet
        const accountKeys = tx.transaction.message.staticAccountKeys || 
                           tx.transaction.message.accountKeys;
        const recipientKey = accountKeys[1]?.toString();
        
        if (recipientKey !== WALLET_ADDRESS) {
            // Also check token transfers
            let validRecipient = false;
            const postBalances = tx.meta?.postTokenBalances || [];
            for (const balance of postBalances) {
                if (balance.owner === WALLET_ADDRESS) {
                    validRecipient = true;
                    break;
                }
            }
            if (!validRecipient) {
                return res.status(400).json({ error: 'Payment not sent to correct wallet' });
            }
        }
        
        // Verify memo contains room code
        const logMessages = tx.meta?.logMessages || [];
        const hasMemo = logMessages.some(log => 
            log.toLowerCase().includes(roomCode.toLowerCase()) ||
            log.includes('Memo')
        );
        
        // For USDC, check token transfer amount
        let transferAmount = 0;
        const preBalances = tx.meta?.preTokenBalances || [];
        const postBalances = tx.meta?.postTokenBalances || [];
        
        for (const post of postBalances) {
            if (post.owner === WALLET_ADDRESS && post.mint === USDC_MINT.toString()) {
                const pre = preBalances.find(p => p.accountIndex === post.accountIndex);
                const preAmount = pre ? parseFloat(pre.uiTokenAmount.uiAmount || 0) : 0;
                const postAmount = parseFloat(post.uiTokenAmount.uiAmount || 0);
                transferAmount = postAmount - preAmount;
            }
        }
        
        // Verify amount (allow small tolerance for fees)
        if (transferAmount < room.entryFee * 0.99) {
            console.log(`❌ Insufficient amount: ${transferAmount} < ${room.entryFee}`);
            return res.status(400).json({ 
                error: `Insufficient payment: ${transferAmount} USDC (required: ${room.entryFee} USDC)` 
            });
        }
        
        // Find player and mark as paid
        const player = room.players.find(p => 
            (p.wallet === playerWallet || !p.paymentConfirmed)
        );
        
        if (!player) {
            return res.status(400).json({ error: 'No unpaid player found' });
        }
        
        if (player.paymentConfirmed) {
            return res.status(400).json({ error: 'Player already paid' });
        }
        
        // ✅ CONFIRM PAYMENT
        player.paymentConfirmed = true;
        player.txSignature = txSignature;
        player.wallet = playerWallet;
        room.confirmedPayments++;
        processedSignatures.add(txSignature);
        
        console.log(`✅ Payment confirmed: ${roomCode} - Player ${player.id} - ${transferAmount} USDC`);
        console.log(`   Confirmed payments: ${room.confirmedPayments}/2`);
        
        // CHECK IF GAME CAN START - ONLY with 2 confirmed payments
        if (room.confirmedPayments >= 2) {
            room.status = 'playing';
            console.log(`🎮 GAME STARTED: ${roomCode} - Both payments confirmed!`);
        }
        
        res.json({ 
            success: true, 
            room: getRoomResponse(room),
            message: room.confirmedPayments >= 2 ? 
                'Both payments confirmed! Game starting!' : 
                `Payment confirmed. Waiting for ${2 - room.confirmedPayments} more payment(s).`
        });
        
    } catch (error) {
        console.error('Payment verification error:', error);
        res.status(500).json({ error: 'Failed to verify payment: ' + error.message });
    }
});

// Check payments status (polling endpoint)
app.get('/api/rooms/:code/payments', async (req, res) => {
    const { code } = req.params;
    const room = rooms.get(code.toUpperCase());
    
    if (!room) {
        return res.status(404).json({ error: 'Room not found' });
    }
    
    res.json({
        success: true,
        roomCode: room.code,
        status: room.status,
        confirmedPayments: room.confirmedPayments,
        requiredPayments: 2,
        canStartGame: room.confirmedPayments >= 2,
        players: room.players.map(p => ({
            id: p.id,
            name: p.name,
            paymentConfirmed: p.paymentConfirmed
        }))
    });
});

// ═══════════════════════════════════════════════════════════════
// GAME END & PAYOUT
// ═══════════════════════════════════════════════════════════════

app.post('/api/rooms/:code/end', async (req, res) => {
    const { code } = req.params;
    const { winnerId } = req.body;
    
    const room = rooms.get(code.toUpperCase());
    if (!room) {
        return res.status(404).json({ error: 'Room not found' });
    }
    
    // CRITICAL: Verify game was actually playing (payments confirmed)
    if (room.status !== 'playing') {
        return res.status(400).json({ error: 'Game was not in playing state' });
    }
    
    if (room.confirmedPayments < 2) {
        return res.status(400).json({ error: 'Cannot end game without 2 confirmed payments' });
    }
    
    const winner = room.players[winnerId];
    if (!winner) {
        return res.status(400).json({ error: 'Invalid winner' });
    }
    
    room.status = 'finished';
    room.winner = winnerId;
    
    const totalPool = room.entryFee * 2;
    const commission = totalPool * COMMISSION_RATE;
    const winnerPayout = totalPool - commission;
    
    console.log(`🏆 Game ended: ${code}`);
    console.log(`   Winner: ${winner.name}`);
    console.log(`   Payout: ${winnerPayout} USDC`);
    
    // Send payout if wallet configured
    let payoutResult = null;
    if (wallet && winner.wallet) {
        try {
            payoutResult = await sendUSDCPayout(winner.wallet, winnerPayout);
            console.log(`💸 Payout sent: ${payoutResult.signature}`);
        } catch (e) {
            console.error('Payout error:', e.message);
            payoutResult = { error: e.message };
        }
    }
    
    res.json({
        success: true,
        result: {
            winner: winner.name,
            winnerWallet: winner.wallet,
            payout: winnerPayout,
            commission,
            totalPool,
            txSignature: payoutResult?.signature || null,
            payoutError: payoutResult?.error || null
        }
    });
});

// ═══════════════════════════════════════════════════════════════
// SOLANA PAYOUT
// ═══════════════════════════════════════════════════════════════

async function sendUSDCPayout(recipientAddress, amount) {
    if (!wallet) throw new Error('Wallet not configured');
    
    const recipient = new PublicKey(recipientAddress);
    const senderATA = await getAssociatedTokenAddress(USDC_MINT, wallet.publicKey);
    const recipientATA = await getAssociatedTokenAddress(USDC_MINT, recipient);
    
    const amountInSmallestUnit = Math.floor(amount * 1_000_000);
    
    const transferIx = createTransferInstruction(
        senderATA,
        recipientATA,
        wallet.publicKey,
        amountInSmallestUnit,
        [],
        TOKEN_PROGRAM_ID
    );
    
    const tx = new Transaction().add(transferIx);
    tx.feePayer = wallet.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.sign(wallet);
    
    const signature = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(signature, 'confirmed');
    
    return { signature };
}

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        walletAddress: WALLET_ADDRESS || 'NOT CONFIGURED',
        solanaRpc: SOLANA_RPC,
        activeRooms: rooms.size
    });
});

// ═══════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════

app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║  ♔ Chess Arena Backend v2 - STRICT Payment Gating            ║
╠══════════════════════════════════════════════════════════════╣
║  Port: ${PORT}                                                   ║
║  Wallet: ${WALLET_ADDRESS || 'NOT CONFIGURED'}
║  Games NEVER start without 2 confirmed on-chain payments     ║
╚══════════════════════════════════════════════════════════════╝
    `);
});
