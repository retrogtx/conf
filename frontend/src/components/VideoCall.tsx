import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { io, Socket } from 'socket.io-client';
import { Button } from './ui/button';

interface PeerConnection {
  id: string;
  connection: RTCPeerConnection;
  stream: MediaStream | null;
}

const VideoCall = () => {
  const { roomCode } = useParams<{ roomCode: string }>();
  const navigate = useNavigate();
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [peers, setPeers] = useState<PeerConnection[]>([]);
  const socketRef = useRef<Socket | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const peerConnectionsRef = useRef<{ [key: string]: RTCPeerConnection }>({});
  const [connectedUsers, setConnectedUsers] = useState<string[]>([]);
  const [connectionTimedOut, setConnectionTimedOut] = useState(false);
  const [networkStatus, setNetworkStatus] = useState<'checking' | 'connected' | 'failed'>('checking');
  // Add a buffer for ICE candidates that arrive before remote description is set
  const iceCandidateBufferRef = useRef<{ [userId: string]: RTCIceCandidateInit[] }>({});
  // Track if we've seen media from each peer
  const peerMediaReceivedRef = useRef<Set<string>>(new Set());
  // Track video elements to check for black screens
  const videoElementsRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  // Track user interaction to handle autoplay policies
  const [userHasInteracted, setUserHasInteracted] = useState(false);

  // Helper function to ensure video plays with browser autoplay policies
  const ensureVideoPlays = async (videoElement: HTMLVideoElement, stream: MediaStream, peerId?: string) => {
    try {
      console.log(`Attempting to play video${peerId ? ` for peer ${peerId}` : ''}`);
      
      if (!videoElement.srcObject) {
        videoElement.srcObject = stream;
      }
      
      await videoElement.play();
      console.log('Video playing successfully');
      return true;
    } catch (err) {
      console.error(`Failed to play video: ${err}`);
      if (err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
        console.log('Browser requires user interaction to play video');
        // If user hasn't interacted with the page yet, we need to show a play button
        if (!userHasInteracted && videoElement.parentElement) {
          const container = videoElement.parentElement;
          // Remove any existing play buttons
          container.querySelectorAll('.video-play-button').forEach(el => el.remove());
          
          // Add a play button that covers the entire video
          const playBtn = document.createElement('button');
          playBtn.textContent = 'Click to Start Video';
          playBtn.className = 'video-play-button absolute inset-0 w-full h-full bg-black bg-opacity-70 text-white flex items-center justify-center';
          playBtn.style.zIndex = '10';
          
          playBtn.onclick = async () => {
            try {
              setUserHasInteracted(true);
              // Temporarily mute to get around autoplay restrictions
              videoElement.muted = true;
              await videoElement.play();
              
              // Now try playing all other videos
              videoElementsRef.current.forEach((vidEl) => {
                if (vidEl !== videoElement && vidEl.paused) {
                  vidEl.play().catch(e => console.log('Still could not play another video:', e));
                }
              });
              
              // After a moment, unmute if this isn't the local video
              if (!videoElement.getAttribute('data-local')) {
                setTimeout(() => {
                  videoElement.muted = false;
                }, 1000);
              }
              
              // Remove the play button
              container.removeChild(playBtn);
            } catch (playErr) {
              console.error('Still failed to play after user interaction:', playErr);
            }
          };
          
          container.appendChild(playBtn);
        }
        return false;
      }
      return false;
    }
  };

  // Define createAndSendOffer at component level so it can be used by multiple functions
  const createAndSendOffer = (peerConnection: RTCPeerConnection, userId: string) => {
    console.log(`Creating offer for ${userId}`);
    
    // Make sure we're in a valid state to create an offer
    if (peerConnection.signalingState === 'closed') {
      console.error('Cannot create offer - peer connection is closed');
      return;
    }
    
    peerConnection
      .createOffer()
      .then((offer) => {
        console.log('Offer created, setting local description');
        return peerConnection.setLocalDescription(offer);
      })
      .then(() => {
        // Add small delay to ensure local description is fully set
        setTimeout(() => {
          if (peerConnection.localDescription) {
            console.log(`Sending offer to ${userId}`);
            socketRef.current?.emit('offer', {
              roomCode,
              offer: peerConnection.localDescription,
              to: userId,
            });
          } else {
            console.error('Local description is null when trying to send offer');
            // Try again after a short delay as a fallback
            setTimeout(() => {
              if (peerConnection.localDescription) {
                console.log(`Retrying sending offer to ${userId}`);
                socketRef.current?.emit('offer', {
                  roomCode,
                  offer: peerConnection.localDescription,
                  to: userId,
                });
              }
            }, 1000);
          }
        }, 100);
      })
      .catch((error) => {
        console.error('Error creating offer:', error);
      });
  };

  // Initialize socket connection and media devices
  useEffect(() => {
    if (!roomCode) {
      navigate('/');
      return;
    }

    console.log(`Joining room: ${roomCode}`);

    // Connect to signaling server with improved configuration
    socketRef.current = io('http://localhost:3000', {
      reconnectionDelayMax: 10000,
      transports: ['websocket', 'polling'],
      timeout: 20000
    });
    const socket = socketRef.current;

    // Get local media stream
    navigator.mediaDevices
      .getUserMedia({ video: true, audio: true })
      .then((stream) => {
        console.log('Local stream obtained:', stream.id);
        setLocalStream(stream);
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }

        // Join the room
        socket.emit('join-room', roomCode);
        console.log('Emitted join-room for', roomCode);

        // Handle new user connection
        socket.on('user-connected', (userId: string) => {
          console.log('New user connected:', userId);
          setConnectedUsers(prev => [...prev, userId]);
          
          // Create a peer connection and send offer
          createPeerConnection(userId, true);
        });

        // Handle existing users in the room
        socket.on('existing-users', (userIds: string[]) => {
          console.log('Existing users in room:', userIds);
          setConnectedUsers(prev => [...prev, ...userIds]);
          
          // Create peer connections with each existing user
          userIds.forEach(userId => {
            console.log('Creating peer connection with existing user:', userId);
            createPeerConnection(userId, true);
          });
        });

        // Handle offer from another peer
        socket.on('offer', async ({ offer, from }: { offer: RTCSessionDescriptionInit; from: string }) => {
          console.log('Received offer from:', from, offer);
          
          try {
            // Create peer connection if it doesn't exist
            const pc = peerConnectionsRef.current[from] || createPeerConnection(from, false);
            
            // First check the signaling state
            console.log(`Current signaling state when receiving offer: ${pc.signalingState}`);
            
            if (pc.signalingState === 'stable') {
              // Normal case - we can set the remote offer
              console.log('Signaling state is stable, setting remote description from offer');
              await pc.setRemoteDescription(new RTCSessionDescription(offer));
              console.log('Set remote description from offer');
              
              // Process any buffered ICE candidates
              const bufferedCandidates = iceCandidateBufferRef.current[from] || [];
              if (bufferedCandidates.length > 0) {
                console.log(`Processing ${bufferedCandidates.length} buffered ICE candidates for ${from}`);
                for (const candidate of bufferedCandidates) {
                  try {
                    await pc.addIceCandidate(new RTCIceCandidate(candidate));
                    console.log('Added buffered ICE candidate');
                  } catch (error) {
                    console.error('Error adding buffered ICE candidate:', error);
                  }
                }
                // Clear buffer after processing
                iceCandidateBufferRef.current[from] = [];
              }
              
              console.log('Creating answer after setting remote offer');
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              console.log('Created and set local answer');
              
              socket.emit('answer', { roomCode, answer, to: from });
              console.log('Sent answer to:', from);
            } else if (pc.signalingState === 'have-local-offer') {
              // Glare condition - both sides created an offer
              // In this case, the peer with the lower ID should accept the other's offer
              const shouldAcceptOffer = from.localeCompare(socket.id || '') > 0;
              
              if (shouldAcceptOffer) {
                console.log('Collision detected, accepting remote offer (glare condition)');
                // Roll back our offer
                try {
                  await pc.setLocalDescription({type: 'rollback'});
                  console.log('Successfully rolled back local offer');
                  
                  // Now we can set their offer and send an answer
                  await pc.setRemoteDescription(new RTCSessionDescription(offer));
                  console.log('Set remote description after rollback');
                  
                  const answer = await pc.createAnswer();
                  await pc.setLocalDescription(answer);
                  console.log('Created and set local answer after rollback');
                  
                  socket.emit('answer', { roomCode, answer, to: from });
                  console.log('Sent answer after handling glare condition');
                } catch (error) {
                  console.error('Error handling glare condition:', error);
                  
                  // As a fallback, recreate the connection
                  pc.close();
                  delete peerConnectionsRef.current[from];
                  
                  // Create a new connection but don't be the initiator
                  const newPc = createPeerConnection(from, false);
                  await newPc.setRemoteDescription(new RTCSessionDescription(offer));
                  const answer = await newPc.createAnswer();
                  await newPc.setLocalDescription(answer);
                  socket.emit('answer', { roomCode, answer, to: from });
                }
              } else {
                console.log('Collision detected, ignoring remote offer (will wait for answer)');
                // Ignore their offer - they should accept ours
              }
            } else {
              console.log(`Unexpected signaling state: ${pc.signalingState}, handling offer carefully`);
              
              // Try to recover by getting to a stable state
              try {
                if ((pc.signalingState as string) !== 'stable') {
                  console.log('Attempting to reset signaling state to stable');
                  await pc.setLocalDescription({type: 'rollback'});
                }
                
                await pc.setRemoteDescription(new RTCSessionDescription(offer));
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                socket.emit('answer', { roomCode, answer, to: from });
              } catch (error) {
                console.error('Could not recover signaling state:', error);
                
                // Nuclear option: recreate the connection
                pc.close();
                delete peerConnectionsRef.current[from];
                const newPc = createPeerConnection(from, false);
                await newPc.setRemoteDescription(new RTCSessionDescription(offer));
                const answer = await newPc.createAnswer();
                await newPc.setLocalDescription(answer);
                socket.emit('answer', { roomCode, answer, to: from });
              }
            }
          } catch (error) {
            console.error('Error handling offer:', error);
          }
        });

        // Handle answer to our offer
        socket.on('answer', async ({ answer, from }: { answer: RTCSessionDescriptionInit; from: string }) => {
          console.log('Received answer from:', from, answer);
          const peerConnection = peerConnectionsRef.current[from];
          
          if (peerConnection) {
            try {
              // Check current signaling state
              console.log(`Current signaling state before setting answer: ${peerConnection.signalingState}`);
              
              if (peerConnection.signalingState === 'have-local-offer') {
                // Normal case - we have an offer and are receiving an answer
                await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
                console.log('Successfully set remote description from answer');
                
                // Process any buffered ICE candidates
                const bufferedCandidates = iceCandidateBufferRef.current[from] || [];
                if (bufferedCandidates.length > 0) {
                  console.log(`Processing ${bufferedCandidates.length} buffered ICE candidates for ${from}`);
                  for (const candidate of bufferedCandidates) {
                    try {
                      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                      console.log('Added buffered ICE candidate');
                    } catch (error) {
                      console.error('Error adding buffered ICE candidate:', error);
                    }
                  }
                  // Clear buffer after processing
                  iceCandidateBufferRef.current[from] = [];
                }
              } else if (peerConnection.signalingState === 'stable') {
                // We received an answer but we're already in stable state
                // This means we either already processed an answer or never sent an offer
                console.warn(`Unexpected signaling state: stable when receiving answer - ignoring answer`);
                
                // Create a fresh offer to resync the connection
                setTimeout(() => {
                  // Check if the peer connection still exists and is in stable state
                  if (peerConnectionsRef.current[from] && peerConnectionsRef.current[from].signalingState === 'stable') {
                    console.log('Creating new offer to resync connection after unexpected answer');
                    createAndSendOffer(peerConnectionsRef.current[from], from);
                  }
                }, 2000);
                
                return; // Skip applying this answer
              } else {
                // Some other unexpected state (have-remote-offer, have-remote-pranswer, have-local-pranswer)
                console.warn(`Unexpected signaling state: ${peerConnection.signalingState} when receiving answer`);
                
                // Try to recover by rolling back if possible
                try {
                  // If we're in have-remote-offer, this might be a glare condition
                  // (both sides created offers simultaneously)
                  if (peerConnection.signalingState === 'have-remote-offer') {
                    console.log('Rolling back to stable state before setting answer');
                    await peerConnection.setLocalDescription({type: 'rollback'});
                    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
                    console.log('Set remote description after rollback');
                  } else {
                    console.log('Attempting to set answer despite unexpected state');
                    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
                    console.log('Set remote description despite unexpected state');
                  }
                } catch (innerError) {
                  console.error('Failed to recover signaling state:', innerError);
                  
                  // As a last resort, recreate the connection
                  console.log('Recreating peer connection due to unrecoverable signaling state');
                  peerConnection.close();
                  delete peerConnectionsRef.current[from];
                  const newPc = createPeerConnection(from, true);
                  
                  // Force a reconnection attempt
                  setTimeout(() => {
                    createAndSendOffer(newPc, from);
                  }, 1000);
                }
              }
            } catch (error) {
              console.error('Error setting remote description from answer:', error);
              
              // Handle specific InvalidStateError
              if (
                error instanceof Error && 
                error.name === 'InvalidStateError' && 
                error.message.includes('Called in wrong state: stable')
              ) {
                console.log('Invalid state error detected - connection already stable');
                
                // Force a new negotiation cycle
                setTimeout(() => {
                  console.log('Attempting negotiation restart after invalid state error');
                  if (peerConnectionsRef.current[from]) {
                    createAndSendOffer(peerConnectionsRef.current[from], from);
                  }
                }, 2000);
              }
            }
          } else {
            console.warn('Received answer for non-existent peer connection:', from);
          }
        });

        // Handle ICE candidate
        socket.on('ice-candidate', async ({ candidate, from }: { candidate: RTCIceCandidateInit; from: string }) => {
          console.log('Received ICE candidate from:', from, candidate);
          const peerConnection = peerConnectionsRef.current[from];
          
          if (peerConnection) {
            try {
              if (peerConnection.remoteDescription) {
                await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                console.log('Added ICE candidate from:', from);
              } else {
                console.warn('Received ICE candidate but remote description not set yet, buffering it');
                
                // Buffer the ICE candidate
                if (!iceCandidateBufferRef.current[from]) {
                  iceCandidateBufferRef.current[from] = [];
                }
                iceCandidateBufferRef.current[from].push(candidate);
              }
            } catch (error) {
              console.error('Error adding ICE candidate:', error);
            }
          } else {
            console.warn('Received ICE candidate for non-existent peer connection:', from);
          }
        });

        // Handle user disconnection
        socket.on('user-disconnected', (userId: string) => {
          console.log('User disconnected:', userId);
          if (peerConnectionsRef.current[userId]) {
            peerConnectionsRef.current[userId].close();
            delete peerConnectionsRef.current[userId];
            setPeers((prevPeers) => prevPeers.filter((peer) => peer.id !== userId));
            setConnectedUsers(prev => prev.filter(id => id !== userId));
          }
        });
      })
      .catch((error) => {
        console.error('Error accessing media devices:', error);
        alert('Failed to access camera and microphone. Please ensure they are connected and permissions are granted.');
      });

    // Detect network connectivity changes
    window.addEventListener('online', () => {
      console.log('Network is online, attempting to reconnect');
      socket.connect();
    });

    window.addEventListener('offline', () => {
      console.log('Network is offline');
      setNetworkStatus('failed');
    });

    // Cleanup on component unmount
    return () => {
      console.log('Component unmounting, cleaning up resources');
      if (localStream) {
        localStream.getTracks().forEach((track) => {
          console.log('Stopping track:', track.kind);
          track.stop();
        });
      }
      
      if (socket) {
        console.log('Disconnecting socket');
        socket.disconnect();
      }
      
      Object.values(peerConnectionsRef.current).forEach((connection) => {
        console.log('Closing peer connection');
        connection.close();
      });

      window.removeEventListener('online', () => {});
      window.removeEventListener('offline', () => {});
    };
  }, [roomCode, navigate]);

  // Add a useEffect to detect connection timeout
  useEffect(() => {
    // If there are users in the room but no peer connections established after 15 seconds
    if (connectedUsers.length > 0 && peerMediaReceivedRef.current.size === 0) {
      const timeoutId = setTimeout(() => {
        console.log('Connection timeout detected. Peers with media:', peerMediaReceivedRef.current.size, 
                    'Connected users:', connectedUsers.length);
        setConnectionTimedOut(true);
      }, 15000);
      
      return () => clearTimeout(timeoutId);
    }
    
    // Reset timeout state if peers with media are connected
    if (peerMediaReceivedRef.current.size > 0 && connectionTimedOut) {
      setConnectionTimedOut(false);
    }
  }, [connectedUsers, connectionTimedOut]);

  // Create a new WebRTC peer connection
  const createPeerConnection = (userId: string, isInitiator: boolean) => {
    console.log(`Creating peer connection with: ${userId}, isInitiator: ${isInitiator}`);
    
    // If connection already exists, return it
    if (peerConnectionsRef.current[userId]) {
      console.log('Peer connection already exists, reusing it');
      return peerConnectionsRef.current[userId];
    }
    
    // Create a new RTCPeerConnection with STUN servers
    const peerConnection = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        // Free public TURN server for testing
        {
          urls: 'turn:openrelay.metered.ca:80',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        },
        {
          urls: 'turn:openrelay.metered.ca:443',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        },
        // Add additional TURN servers
        {
          urls: 'turn:openrelay.metered.ca:443?transport=tcp',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        },
        {
          urls: 'turn:global.turn.twilio.com:3478?transport=udp',
          username: 'f4b4035eaa76f4a55de5f4351567653ee4ff6fa97b50b6b334fcc1be9c27212d',
          credential: 'w1WpNmw7hZpqfWs+14npDq1UyKEMnw33sHUjiWct7lc='
        }
      ],
      iceCandidatePoolSize: 10,
      iceTransportPolicy: 'all' // Try 'relay' if still having issues
    });

    // Store the connection
    peerConnectionsRef.current[userId] = peerConnection;

    // Log connection state changes
    peerConnection.onconnectionstatechange = () => {
      console.log(`Connection state with ${userId}: ${peerConnection.connectionState}`);
      
      if (peerConnection.connectionState === 'connected') {
        setNetworkStatus('connected');
      } else if (peerConnection.connectionState === 'failed') {
        setNetworkStatus('failed');
      }
    };

    // Log ICE connection state changes
    peerConnection.oniceconnectionstatechange = () => {
      console.log(`ICE connection state with ${userId}: ${peerConnection.iceConnectionState}`);
      
      // If connected successfully, update the UI
      if (peerConnection.iceConnectionState === 'connected' || 
          peerConnection.iceConnectionState === 'completed') {
        console.log(`Successfully established connection with ${userId}`);
        setNetworkStatus('connected');
        
        // Check if we've added this user to peers yet - add a placeholder if needed
        setPeers(prevPeers => {
          if (!prevPeers.some(p => p.id === userId)) {
            console.log(`Adding placeholder peer for ${userId} until media arrives`);
            return [...prevPeers, { id: userId, connection: peerConnection, stream: null }];
          }
          return prevPeers;
        });
      }
      
      // If failed, log the error
      if (peerConnection.iceConnectionState === 'failed' || 
          peerConnection.iceConnectionState === 'disconnected') {
        console.error(`WebRTC connection with ${userId} failed or disconnected`);
        setNetworkStatus('failed');
      }
    };
    
    // Log ICE gathering state changes
    peerConnection.onicegatheringstatechange = () => {
      console.log(`ICE gathering state with ${userId}: ${peerConnection.iceGatheringState}`);
    };

    // Add local tracks to the connection
    if (localStream) {
      try {
        // Add tracks from localStream to the peer connection
        console.log(`Adding ${localStream.getTracks().length} tracks to peer connection for ${userId}`);
        
        // Ensure no duplicate track adding by checking existing senders
        const existingSenderKinds = peerConnection.getSenders().map(sender => 
          sender.track?.kind || 'unknown');
        
        localStream.getTracks().forEach((track) => {
          // Skip if we already have a sender for this track kind
          if (existingSenderKinds.includes(track.kind)) {
            console.log(`Skipping ${track.kind} track - already added to peer connection`);
            return;
          }
          
          console.log(`Adding ${track.kind} track to peer connection for ${userId}`);
          try {
            peerConnection.addTrack(track, localStream);
            console.log(`Successfully added ${track.kind} track to peer connection`);
          } catch (error) {
            console.error(`Failed to add ${track.kind} track:`, error);
          }
        });
        
        // Log all transceivers to verify send/recv direction
        const transceivers = peerConnection.getTransceivers();
        console.log(`Peer connection has ${transceivers.length} transceivers`);
        transceivers.forEach((transceiver, index) => {
          console.log(`Transceiver ${index}: kind=${transceiver.sender.track?.kind}, direction=${transceiver.direction}`);
        });
      } catch (error) {
        console.error('Error adding local tracks to peer connection:', error);
      }
    } else {
      console.warn('No local stream available when creating peer connection');
    }

    // Handle ICE candidates
    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        console.log(`Generated ICE candidate for ${userId}: ${event.candidate.candidate.substring(0, 50)}...`);
        // Make sure we're connected before sending
        if (socketRef.current?.connected) {
          socketRef.current.emit('ice-candidate', {
            roomCode,
            candidate: event.candidate,
            to: userId,
          });
        } else {
          console.error('Socket not connected when trying to send ICE candidate');
          // Try to reconnect
          socketRef.current?.connect();
          // Queue the candidate to try again shortly
          setTimeout(() => {
            if (socketRef.current?.connected) {
              console.log('Retrying sending ICE candidate after reconnect');
              socketRef.current.emit('ice-candidate', {
                roomCode,
                candidate: event.candidate,
                to: userId,
              });
            }
          }, 1000);
        }
      } else {
        console.log(`All ICE candidates gathered for connection with ${userId}`);
      }
    };

    // Add connection negotiation needed event handler
    peerConnection.onnegotiationneeded = () => {
      console.log(`Negotiation needed for connection with ${userId}`);
      if (isInitiator) {
        console.log(`Creating offer due to negotiation with ${userId}`);
        createAndSendOffer(peerConnection, userId);
      }
    };

    // Handle incoming tracks
    peerConnection.ontrack = (event) => {
      console.log(`Received remote track from ${userId}:`, event.streams[0]?.id);
      
      if (event.streams && event.streams[0]) {
        const remoteStream = event.streams[0];
        
        // Ensure we're keeping track of this stream
        console.log(`Adding remote stream from ${userId} with ${remoteStream.getTracks().length} tracks`);
        remoteStream.getTracks().forEach(track => {
          console.log(`Remote track type: ${track.kind}, enabled: ${track.enabled}, muted: ${track.muted}`);
          
          // Monitor track status changes
          track.onended = () => console.log(`Remote ${track.kind} track ended from ${userId}`);
          track.onmute = () => console.log(`Remote ${track.kind} track muted from ${userId}`);
          track.onunmute = () => console.log(`Remote ${track.kind} track unmuted from ${userId}`);
          
          // Make sure the track is enabled
          if (!track.enabled) {
            console.warn(`Remote track was disabled, enabling it`);
            track.enabled = true;
          }
        });
        
        // Mark that we've received media from this peer
        peerMediaReceivedRef.current.add(userId);
        
        setPeers((prevPeers) => {
          // Check if this peer already exists
          const existingPeerIndex = prevPeers.findIndex((p) => p.id === userId);
          
          if (existingPeerIndex >= 0) {
            console.log(`Updating existing peer ${userId} with new stream`);
            const updatedPeers = [...prevPeers];
            updatedPeers[existingPeerIndex] = { 
              ...updatedPeers[existingPeerIndex], 
              stream: remoteStream 
            };
            return updatedPeers;
          } else {
            console.log(`Adding new peer ${userId} with stream`);
            return [
              ...prevPeers,
              { id: userId, connection: peerConnection, stream: remoteStream },
            ];
          }
        });
      } else {
        console.warn(`Received track event from ${userId} without a valid stream`);
      }
    };

    // If we're the initiator, create and send an offer
    if (isInitiator) {
      // Create an offer immediately instead of waiting for negotiation
      console.log(`Creating immediate offer for ${userId} as initiator`);
      
      // Add a small delay to allow event handlers to be registered
      setTimeout(() => {
        // Check if the peer connection still exists
        if (peerConnectionsRef.current[userId]) {
          const currentPeerConnection = peerConnectionsRef.current[userId];
          
          // Clear any existing remote description to ensure clean negotiation
          if (currentPeerConnection.signalingState !== 'stable' && currentPeerConnection.remoteDescription) {
            console.log('Resetting to stable state before creating offer');
            try {
              currentPeerConnection.setLocalDescription({type: 'rollback'});
              console.log('Successfully rolled back to stable state');
            } catch (err) {
              console.warn('Rollback failed, proceeding anyway:', err);
            }
          }
          
          createAndSendOffer(currentPeerConnection, userId);
        }
      }, 1000); // Short delay to ensure tracks are added
    }

    return peerConnection;
  };

  const handleLeaveCall = () => {
    // Stop all tracks
    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
    }
    
    // Close all peer connections
    Object.values(peerConnectionsRef.current).forEach((connection) => {
      connection.close();
    });
    
    // Disconnect socket
    socketRef.current?.disconnect();
    
    // Navigate back to home
    navigate('/');
  };

  // Force connection retry
  const handleForceRetry = () => {
    console.log("Forcing connection retry");
    
    // Close existing connections
    Object.entries(peerConnectionsRef.current).forEach(([userId, connection]) => {
      connection.close();
      delete peerConnectionsRef.current[userId];
      
      // Create new connections with all users
      if (connectedUsers.includes(userId)) {
        createPeerConnection(userId, true);
      }
    });
    
    // Reset state
    setConnectionTimedOut(false);
    setNetworkStatus('checking');
  };

  // Function to retry video connection if black screen is detected
  const retryVideoConnection = (userId: string) => {
    console.log(`Retrying video connection for peer ${userId}`);
    
    const peer = peerConnectionsRef.current[userId];
    if (!peer) {
      console.warn(`Cannot retry - no peer connection for ${userId}`);
      return;
    }
    
    // Close and recreate the connection
    peer.close();
    delete peerConnectionsRef.current[userId];
    
    // Create a new connection with forced media
    createPeerConnection(userId, true);
    
    // Force a renegotiation
    setTimeout(() => {
      if (peerConnectionsRef.current[userId]) {
        console.log(`Sending new offer after retry for ${userId}`);
        createAndSendOffer(peerConnectionsRef.current[userId], userId);
      }
    }, 1000);
  };

  // Add monitor for black video screens
  useEffect(() => {
    // Check for black screens after a peer has been connected for a while
    const videoCheckTimeout = setTimeout(() => {
      peers.forEach(peer => {
        const videoElement = videoElementsRef.current.get(peer.id);
        if (videoElement && peer.stream && peer.stream.active) {
          console.log(`Checking if video for peer ${peer.id} is displaying properly`);
          
          // If video has stalled or failed to play
          if (videoElement.paused || videoElement.ended || videoElement.readyState === 0) {
            console.warn(`Video for peer ${peer.id} is not playing properly, attempting to restart`);
            
            // Try to play the video again
            videoElement.play().catch(err => {
              console.error(`Failed to restart video for peer ${peer.id}:`, err);
            });
          }
        }
      });
    }, 5000);
    
    return () => clearTimeout(videoCheckTimeout);
  }, [peers]);

  // Add more comprehensive monitor for video playback issues
  useEffect(() => {
    if (peers.length === 0) return;
    
    const videoCheckInterval = setInterval(() => {
      // Check all peer video elements
      let hasPlaybackIssues = false;
      
      peers.forEach(peer => {
        const videoElement = videoElementsRef.current.get(peer.id);
        if (videoElement && peer.stream && peer.stream.active) {
          console.log(`Checking video playback for peer ${peer.id}`);
          
          // Check if the video is actually playing and displaying content
          if (videoElement.paused || videoElement.ended || videoElement.readyState === 0) {
            console.warn(`Video for peer ${peer.id} is not playing properly`);
            hasPlaybackIssues = true;
            
            // Try to play the video again
            ensureVideoPlays(videoElement, peer.stream, peer.id);
          }
          
          // Additional check for black screen: if video is playing but no tracks are active
          if (!videoElement.paused && (!peer.stream.getVideoTracks().length || 
              !peer.stream.getVideoTracks().some(track => track.enabled))) {
            console.warn(`Peer ${peer.id} video is playing but has no active video tracks`);
            hasPlaybackIssues = true;
          }
        } else if (peer.stream === null && peerConnectionsRef.current[peer.id]) {
          // Peer connection exists but no stream
          console.warn(`Peer ${peer.id} has connection but no stream`);
          hasPlaybackIssues = true;
        }
      });
      
      // If we still haven't received media but we have connections, try a forced reset
      if (hasPlaybackIssues && peers.length > 0 && peers.some(p => p.stream === null) && !connectionTimedOut) {
        console.log("Extended timeout detected - some peers have connections but no media");
        
        // Only reset if we haven't done so already
        if (networkStatus !== 'failed') {
          setNetworkStatus('failed');
          
          // Force a reconnection
          const peersToReset = peers.filter(p => p.stream === null).map(p => p.id);
          console.log(`Forcing reconnection for peers: ${peersToReset.join(', ')}`);
          
          peersToReset.forEach(peerId => {
            setTimeout(() => {
              retryVideoConnection(peerId);
            }, 500);
          });
        }
      }
    }, 10000); // Check every 10 seconds
    
    return () => clearInterval(videoCheckInterval);
  }, [peers, networkStatus, connectionTimedOut]);

  return (
    <div className="flex flex-col h-screen bg-gray-100">
      <div className="p-4 bg-white shadow-sm">
        <div className="flex justify-between items-center">
          <h1 className="text-xl font-bold">Room: {roomCode}</h1>
          <div>
            <span className="mr-2">Connected users: {connectedUsers.length + 1}</span>
            <Button variant="destructive" onClick={handleLeaveCall}>
              Leave Call
            </Button>
          </div>
        </div>
      </div>
      
      <div className="flex-1 p-4 overflow-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* Local video */}
          <div className="relative bg-black rounded-lg overflow-hidden aspect-video">
            <video
              ref={localVideoRef}
              autoPlay
              muted
              playsInline
              data-local="true"
              className="w-full h-full object-cover"
              onLoadedMetadata={() => {
                if (localVideoRef.current && localStream) {
                  ensureVideoPlays(localVideoRef.current, localStream);
                }
              }}
            />
            <div className="absolute bottom-2 left-2 bg-black bg-opacity-50 text-white px-2 py-1 rounded">
              You (Local)
            </div>
          </div>
          
          {/* Remote videos */}
          {peers.map((peer) => (
            <div key={peer.id} className="relative bg-black rounded-lg overflow-hidden aspect-video">
              <video
                autoPlay
                playsInline
                muted={false}
                className="w-full h-full object-cover"
                ref={(element) => {
                  if (element) {
                    if (peer.stream) {
                      // Store reference to video element for black screen detection
                      videoElementsRef.current.set(peer.id, element);
                      
                      // Ensure video plays with our helper
                      ensureVideoPlays(element, peer.stream, peer.id);
                    } else if (!peer.stream) {
                      console.warn(`Video element exists for peer ${peer.id} but stream is null`);
                      // Clear srcObject if there's no stream
                      if (element.srcObject) {
                        element.srcObject = null;
                      }
                    }
                  }
                }}
              />
              <div className="absolute bottom-2 left-2 bg-black bg-opacity-50 text-white px-2 py-1 rounded">
                Peer {peer.id.substring(0, 5)}
              </div>
              <Button
                variant="secondary"
                size="sm"
                className="absolute top-2 right-2 bg-black bg-opacity-50 hover:bg-opacity-70"
                onClick={() => retryVideoConnection(peer.id)}
              >
                Retry Video
              </Button>
            </div>
          ))}
          
          {peers.length === 0 && connectedUsers.length > 0 && (
            <div className="col-span-full flex flex-col items-center justify-center p-8 bg-gray-200 rounded-lg">
              {connectionTimedOut ? (
                <>
                  <p className="text-gray-700 font-bold mb-2">Connection issue detected</p>
                  <p className="text-gray-600 mb-4 text-center">
                    This might be due to network restrictions or firewall settings. 
                    WebRTC requires working STUN/TURN servers and open UDP ports.
                  </p>
                  <div className="flex space-x-4">
                    <Button 
                      onClick={() => window.location.reload()}
                    >
                      Refresh Page
                    </Button>
                    <Button 
                      onClick={handleForceRetry}
                      variant="outline"
                    >
                      Retry Connection
                    </Button>
                  </div>
                  <div className="mt-4 p-2 bg-gray-100 rounded text-xs text-gray-500 w-full max-w-md">
                    <p className="font-semibold mb-1">Debugging Info:</p>
                    <p>Network Status: {networkStatus}</p>
                    <p>Connected Users: {connectedUsers.length + 1}</p>
                    <p>Active Video Peers: {peers.filter(p => p.stream !== null).length}</p>
                  </div>
                </>
              ) : (
                <p className="text-gray-500">
                  Connecting to peers... Please wait or try refreshing if this takes too long.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default VideoCall; 