import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { io, Socket } from 'socket.io-client';
import { Button } from './ui/button';

interface PeerConnection {
  id: string;
  connection: RTCPeerConnection;
  stream?: MediaStream;
}

const VideoCall = () => {
  const { roomCode } = useParams<{ roomCode: string }>();
  const navigate = useNavigate();
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [peers, setPeers] = useState<PeerConnection[]>([]);
  const socketRef = useRef<Socket | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const peerConnectionsRef = useRef<{ [key: string]: RTCPeerConnection }>({});

  // Initialize socket connection and media devices
  useEffect(() => {
    if (!roomCode) {
      navigate('/');
      return;
    }

    // Connect to signaling server
    socketRef.current = io('http://localhost:3000');
    const socket = socketRef.current;

    // Get local media stream
    navigator.mediaDevices
      .getUserMedia({ video: true, audio: true })
      .then((stream) => {
        setLocalStream(stream);
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }

        // Join the room
        socket.emit('join-room', roomCode);

        // Handle new user connection
        socket.on('user-connected', (userId: string) => {
          console.log('New user connected:', userId);
          createPeerConnection(userId, true);
        });

        // Handle offer from another peer
        socket.on('offer', async ({ offer, from }: { offer: RTCSessionDescriptionInit; from: string }) => {
          console.log('Received offer from:', from);
          const peerConnection = createPeerConnection(from, false);
          await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
          const answer = await peerConnection.createAnswer();
          await peerConnection.setLocalDescription(answer);
          socket.emit('answer', { roomCode, answer, to: from });
        });

        // Handle answer to our offer
        socket.on('answer', async ({ answer, from }: { answer: RTCSessionDescriptionInit; from: string }) => {
          console.log('Received answer from:', from);
          const peerConnection = peerConnectionsRef.current[from];
          if (peerConnection) {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
          }
        });

        // Handle ICE candidate
        socket.on('ice-candidate', async ({ candidate, from }: { candidate: RTCIceCandidateInit; from: string }) => {
          console.log('Received ICE candidate from:', from);
          const peerConnection = peerConnectionsRef.current[from];
          if (peerConnection) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
          }
        });

        // Handle user disconnection
        socket.on('user-disconnected', (userId: string) => {
          console.log('User disconnected:', userId);
          if (peerConnectionsRef.current[userId]) {
            peerConnectionsRef.current[userId].close();
            delete peerConnectionsRef.current[userId];
            setPeers((prevPeers) => prevPeers.filter((peer) => peer.id !== userId));
          }
        });
      })
      .catch((error) => {
        console.error('Error accessing media devices:', error);
        alert('Failed to access camera and microphone. Please ensure they are connected and permissions are granted.');
      });

    // Cleanup on component unmount
    return () => {
      if (localStream) {
        localStream.getTracks().forEach((track) => track.stop());
      }
      
      if (socket) {
        socket.disconnect();
      }
      
      Object.values(peerConnectionsRef.current).forEach((connection) => {
        connection.close();
      });
    };
  }, [roomCode, navigate]);

  // Create a new WebRTC peer connection
  const createPeerConnection = (userId: string, isInitiator: boolean) => {
    console.log('Creating peer connection with:', userId, 'isInitiator:', isInitiator);
    
    // Create a new RTCPeerConnection
    const peerConnection = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    });

    // Store the connection
    peerConnectionsRef.current[userId] = peerConnection;

    // Add local tracks to the connection
    if (localStream) {
      localStream.getTracks().forEach((track) => {
        peerConnection.addTrack(track, localStream);
      });
    }

    // Handle ICE candidates
    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        socketRef.current?.emit('ice-candidate', {
          roomCode,
          candidate: event.candidate,
          to: userId,
        });
      }
    };

    // Handle incoming tracks
    peerConnection.ontrack = (event) => {
      console.log('Received remote track from:', userId);
      const [remoteStream] = event.streams;
      
      setPeers((prevPeers) => {
        // Check if this peer already exists
        const existingPeer = prevPeers.find((p) => p.id === userId);
        if (existingPeer) {
          return prevPeers.map((p) =>
            p.id === userId ? { ...p, stream: remoteStream } : p
          );
        } else {
          return [
            ...prevPeers,
            { id: userId, connection: peerConnection, stream: remoteStream },
          ];
        }
      });
    };

    // If we're the initiator, create and send an offer
    if (isInitiator && localStream) {
      peerConnection
        .createOffer()
        .then((offer) => peerConnection.setLocalDescription(offer))
        .then(() => {
          socketRef.current?.emit('offer', {
            roomCode,
            offer: peerConnection.localDescription,
            to: userId,
          });
        })
        .catch((error) => {
          console.error('Error creating offer:', error);
        });
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

  return (
    <div className="flex flex-col h-screen bg-gray-100">
      <div className="p-4 bg-white shadow-sm">
        <div className="flex justify-between items-center">
          <h1 className="text-xl font-bold">Room: {roomCode}</h1>
          <Button variant="destructive" onClick={handleLeaveCall}>
            Leave Call
          </Button>
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
              className="w-full h-full object-cover"
            />
            <div className="absolute bottom-2 left-2 bg-black bg-opacity-50 text-white px-2 py-1 rounded">
              You
            </div>
          </div>
          
          {/* Remote videos */}
          {peers.map((peer) => (
            <div key={peer.id} className="relative bg-black rounded-lg overflow-hidden aspect-video">
              <video
                autoPlay
                playsInline
                className="w-full h-full object-cover"
                ref={(element) => {
                  if (element && peer.stream) {
                    element.srcObject = peer.stream;
                  }
                }}
              />
              <div className="absolute bottom-2 left-2 bg-black bg-opacity-50 text-white px-2 py-1 rounded">
                Peer {peer.id.substring(0, 5)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default VideoCall; 