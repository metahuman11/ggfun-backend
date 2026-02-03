/**
 * Chess Arena - Solana Backend
 * Handles payments and payouts
 */

const express = require('express');
const cors = require('cors');
const { Connection, PublicKey, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
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
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || ''; // Base58 encoded
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'); // Mainnet USDC
const COMMISSION_RATE = 0.10; // 10%

// Initialize Solana connection
const connection = new Connection(SOLANA_RPC, 'confirmed');

// Load wallet (for payouts)
let wallet = null;
if (WALLET_PRIVATE_KEY) {
    try {
        const secretKey = bs58.decode(WALLET_PRIVATE_KEY);
        wallet = Keypair.fromSecretKey(secretKey);
        console.log('✅ Wallet loaded:', wallet.publicKey.toString());
    } catch (e) {
        console.error('❌ Failed to load wallet:', e.message);
    }
}

// ═══════════════════════════════════════════════════════════════
// IN-MEMORY DATABASE (use Redis/MongoDB in production)
// ═══════════════════════════════════════════════════════════════
const rooms = new Map();
const payments = new Map();

// ═══════════════════════════════════════════════════════════════
// ROOM MANAGEMENT
// ═══════════════════════════════════════════════════════════════

// Create room
app.post('/api/rooms', (req, res) => {
    const { entryFee, creatorName, creatorWallet } = req.body;
    
    const roomCode = generateRoomCode();
    const room = {
        code: roomCode,
        entryFee: parseFloat(entryFee) || 5,
        prizePool: 0,
        status: 'waiting', // waiting, playing, finished
        players: [{
            id: 0,
            name: creatorName || 'Player 1',
            wallet: creatorWallet,
            color: 'white',
            paid: false
        }],
        winner: null,
        createdAt: Date.now()
    };
    
    rooms.set(roomCode, room);
    console.log(`🆕 Room created: ${roomCode} (${entryFee} USDC)`);
    
    res.json({
        success: true,
        room: {
            code: roomCode,
            entryFee: room.entryFee,
            walletAddress: wallet ? wallet.publicKey.toString() : 'NOT_CONFIGURED',
            memo: roomCode
        }
    });
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
    if (room.status !== 'waiting') {
        return res.status(400).json({ error: 'Game already started' });
    }
    
    room.players.push({
        id: 1,
        name: playerName || 'Player 2',
        wallet: playerWallet,
        color: 'black',
        paid: false
    });
    
    console.log(`🚪 Player joined room: ${code}`);
    res.json({ success: true, room });
});

// Get room status
app.get('/api/rooms/:code', (req, res) => {
    const { code } = req.params;
    const room = rooms.get(code.toUpperCase());
    
    if (!room) {
        return res.status(404).json({ error: 'Room not found' });
    }
    
    res.json({ success: true, room });
});

// List active rooms
app.get('/api/rooms', (req, res) => {
    const activeRooms = [];
    rooms.forEach((room, code) => {
        if (room.status === 'waiting' && room.players.length < 2) {
            activeRooms.push({
                code,
                entryFee: room.entryFee,
                creator: room.players[0]?.name,
                createdAt: room.createdAt
            });
        }
    });
    res.json({ success: true, rooms: activeRooms });
});

// ═══════════════════════════════════════════════════════════════
// PAYMENT VERIFICATION
// ═══════════════════════════════════════════════════════════════

// Check for payments to a room
app.post('/api/payments/check', async (req, res) => {
    const { roomCode } = req.body;
    
    const room = rooms.get(roomCode.toUpperCase());
    if (!room) {
        return res.status(404).json({ error: 'Room not found' });
    }
    
    try {
        // Get recent transactions to our wallet
        const walletPubkey = wallet ? wallet.publicKey : null;
        if (!walletPubkey) {
            return res.status(500).json({ error: 'Wallet not configured' });
        }
        
        const signatures = await connection.getSignaturesForAddress(walletPubkey, { limit: 20 });
        
        for (const sigInfo of signatures) {
            // Skip if already processed
            if (payments.has(sigInfo.signature)) continue;
            
            try {
                const tx = await connection.getTransaction(sigInfo.signature, {
                    maxSupportedTransactionVersion: 0
                });
                
                if (!tx || !tx.meta) continue;
                
                // Check memo for room code
                const memoInstruction = tx.transaction.message.compiledInstructions?.find(
                    inst => inst.programIdIndex !== undefined
                );
                
                // Parse memo (simplified - in production use proper memo parsing)
                const logMessages = tx.meta.logMessages || [];
                const memoLog = logMessages.find(log => log.includes('Memo') || log.includes(roomCode));
                
                if (memoLog && memoLog.includes(roomCode)) {
                    // Found payment for this room!
                    // Determine amount (simplified - check token transfers in production)
                    const preBalances = tx.meta.preTokenBalances || [];
                    const postBalances = tx.meta.postTokenBalances || [];
                    
                    // Mark payment as processed
                    payments.set(sigInfo.signature, {
                        roomCode,
                        timestamp: Date.now()
                    });
                    
                    // Update room
                    const senderKey = tx.transaction.message.staticAccountKeys[0].toString();
                    const player = room.players.find(p => p.wallet === senderKey || !p.paid);
                    if (player && !player.paid) {
                        player.paid = true;
                        room.prizePool += room.entryFee;
                        console.log(`💰 Payment confirmed for room ${roomCode}: ${room.entryFee} USDC`);
                    }
                }
            } catch (txError) {
                console.error('Error parsing transaction:', txError.message);
            }
        }
        
        // Check if both players paid
        const allPaid = room.players.length === 2 && room.players.every(p => p.paid);
        if (allPaid && room.status === 'waiting') {
            room.status = 'playing';
            console.log(`🎮 Game started: ${roomCode}`);
        }
        
        res.json({
            success: true,
            room: {
                code: room.code,
                status: room.status,
                prizePool: room.prizePool,
                players: room.players.map(p => ({
                    name: p.name,
                    color: p.color,
                    paid: p.paid
                }))
            }
        });
        
    } catch (error) {
        console.error('Payment check error:', error);
        res.status(500).json({ error: 'Failed to check payments' });
    }
});

// Manual payment confirmation (for testing)
app.post('/api/payments/confirm', (req, res) => {
    const { roomCode, playerId } = req.body;
    
    const room = rooms.get(roomCode.toUpperCase());
    if (!room) {
        return res.status(404).json({ error: 'Room not found' });
    }
    
    const player = room.players[playerId];
    if (player && !player.paid) {
        player.paid = true;
        room.prizePool += room.entryFee;
        console.log(`💰 Manual payment confirmed: ${roomCode} player ${playerId}`);
    }
    
    // Check if game can start
    if (room.players.length === 2 && room.players.every(p => p.paid)) {
        room.status = 'playing';
    }
    
    res.json({ success: true, room });
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
    
    if (room.status === 'finished') {
        return res.status(400).json({ error: 'Game already finished' });
    }
    
    const winner = room.players[winnerId];
    if (!winner) {
        return res.status(400).json({ error: 'Invalid winner' });
    }
    
    room.status = 'finished';
    room.winner = winnerId;
    
    // Calculate payout
    const totalPool = room.prizePool;
    const commission = totalPool * COMMISSION_RATE;
    const winnerPayout = totalPool - commission;
    
    console.log(`🏆 Game ended: ${code}`);
    console.log(`   Winner: ${winner.name} (${winner.color})`);
    console.log(`   Payout: ${winnerPayout} USDC`);
    console.log(`   Commission: ${commission} USDC`);
    
    // Send payout
    if (wallet && winner.wallet) {
        try {
            const payoutResult = await sendUSDCPayout(winner.wallet, winnerPayout);
            console.log(`💸 Payout sent: ${payoutResult.signature}`);
            
            res.json({
                success: true,
                result: {
                    winner: winner.name,
                    payout: winnerPayout,
                    commission,
                    txSignature: payoutResult.signature
                }
            });
        } catch (payoutError) {
            console.error('Payout error:', payoutError);
            res.json({
                success: true,
                result: {
                    winner: winner.name,
                    payout: winnerPayout,
                    commission,
                    payoutError: payoutError.message
                }
            });
        }
    } else {
        res.json({
            success: true,
            result: {
                winner: winner.name,
                payout: winnerPayout,
                commission,
                note: 'Manual payout required'
            }
        });
    }
});

// ═══════════════════════════════════════════════════════════════
// SOLANA FUNCTIONS
// ═══════════════════════════════════════════════════════════════

async function sendUSDCPayout(recipientAddress, amount) {
    if (!wallet) throw new Error('Wallet not configured');
    
    const recipient = new PublicKey(recipientAddress);
    
    // Get token accounts
    const senderATA = await getAssociatedTokenAddress(USDC_MINT, wallet.publicKey);
    const recipientATA = await getAssociatedTokenAddress(USDC_MINT, recipient);
    
    // USDC has 6 decimals
    const amountInSmallestUnit = Math.floor(amount * 1_000_000);
    
    // Create transfer instruction
    const transferIx = createTransferInstruction(
        senderATA,
        recipientATA,
        wallet.publicKey,
        amountInSmallestUnit,
        [],
        TOKEN_PROGRAM_ID
    );
    
    // Build transaction
    const tx = new Transaction().add(transferIx);
    tx.feePayer = wallet.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    
    // Sign and send
    tx.sign(wallet);
    const signature = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(signature);
    
    return { signature };
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        wallet: wallet ? wallet.publicKey.toString() : 'not configured',
        rooms: rooms.size,
        uptime: process.uptime()
    });
});

// ═══════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════

app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║  ♔ Chess Arena - Solana Backend                              ║
╠══════════════════════════════════════════════════════════════╣
║  Port: ${PORT}                                                   ║
║  RPC: ${SOLANA_RPC.substring(0, 40)}...                        
║  Wallet: ${wallet ? wallet.publicKey.toString().substring(0, 20) + '...' : 'NOT CONFIGURED'}
║  Commission: ${COMMISSION_RATE * 100}%                                            ║
╚══════════════════════════════════════════════════════════════╝
    `);
});
