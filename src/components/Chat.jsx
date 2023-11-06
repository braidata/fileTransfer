import React from "react";
import Peer  from "peerjs";

const Chat = () => {
    const [peer, setPeer] = React.useState(null);
    const [peerId, setPeerId] = React.useState(null);
    const [remotePeerId, setRemotePeerId] = React.useState("");
    const [conn, setConn] = React.useState(null);
    const [nombre, setNombre] = React.useState("");
    const [usuario, setUsuario] = React.useState("");
    const [mensaje, setMensaje] = React.useState("");
    const [votos, setVotos] = React.useState(0);
    const [isOpenAcordeon1, setIsOpenAcordeon1] = React.useState(false);
    const [isOpenAcordeon2, setIsOpenAcordeon2] = React.useState(false);
    const [mensajeR, setMensajeR] = React.useState("");
    const [copiado, setCopiado] = React.useState(null);
    const [connectR, setConnectR] = React.useState(null);
    const [nueva, setNueva] = React.useState(false);
    const [mensajesChat, setMensajesChat] = React.useState([]);
    const [isPeerConnected, setIsPeerConnected] = React.useState(false);

    const handleVotar = () => setVotos((prevVotos) => prevVotos + 1);

    React.useEffect(() => {
        const peerInstance = new Peer();

        setPeer(peerInstance);

        peerInstance.on("open", (id) => {
            setPeerId(id);
        });

        peerInstance.on("connection", (connection) => {
            setConn(connection);

            if (!isPeerConnected) {
                // Lógica para la primera conexión
                alert("Primera conexión establecida");
                setIsPeerConnected(true);
            }

            connection.on("data", (data) => {
                // Lógica para mensajes recibidos
                //alert('Mensaje recibido');
                setMensajeR(data);
                setNueva(true);
                handleVotar();

                // Añadir el mensaje recibido al array de chat
                setMensajesChat((prevMensajes) => [
                    ...prevMensajes,
                    { tipo: "recibido", texto: data },
                ]);
            });
        });

        // Limpieza al desmontar, si es necesario
        return () => {
            // Código para limpiar (por ejemplo, cerrar conexiones)
        };
    }, []); // Nota: el array vacío [] significa que este useEffect se ejecuta solo al montar y desmontar

    const conectarConPeer = () => {
        if (peer) {
            const connection = peer.connect(remotePeerId);
            setConn(connection);

            connection.on("open", () => {
                console.log("Conexión establecida con:", remotePeerId);
                connection.send("¡Conexión exitosa!");
                setNueva(true);
            });

            connection.on("data", (data) => {
                //alert('Información Actualizada');
                setMensajeR(`Origen: ${data}`);
                setNueva(true);
                handleVotar(); // Mueve esta llamada aquí.
                setMensajesChat((prevMensajes) => [
                    ...prevMensajes,
                    { tipo: "recibido", texto: data },
                ]);
            });
        }
    };

    const enviarMensaje = (event) => {
        event.preventDefault();
        if (conn) {
            conn.send(mensaje);
            setMensajesChat((prevMensajes) => [
                ...prevMensajes,
                { tipo: "enviado", texto: mensaje },
            ]);
            setMensaje("");
        }
    };

    const handleKeyDown = (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault(); // Evita el salto de línea
            enviarMensaje(event);  // Envía el mensaje
        }
    };
    

    const toggleAcordeon1 = () => setIsOpenAcordeon1((prev) => !prev);
    const toggleAcordeon2 = () => setIsOpenAcordeon2((prev) => !prev);

    const copiarIdAlPortapapeles = () => {
        if (peerId) {
            const textarea = document.createElement("textarea");
            textarea.value = peerId;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand("copy");
            document.body.removeChild(textarea);
            setCopiado("ID copiado al portapapeles.");
        }
    };

    const limpiarChat = () => {
        setMensajesChat([]);
    };

    return (
        <div className="mt-24 mx-2 my-2 text-gray-800  dark:text-gray-400 bg-gray-300 dark:bg-gray-900 p-6 shadow-md rounded-md">
            {nueva ? (
                <div className="w-6 h-6 rounded-full text-center text-gray-800  dark:text-gray-400 notification-circle bg-green-200">
                    {votos}
                </div>
            ) : (
                <div className="w-6 h-6 rounded-full notification-circle bg-transparent"></div>
            )}
            <div className="mb-4 flex flex-col justify-between items-center mb-4">
                <div className="flex flex-col flex-grow gap-2 text-gray-800  dark:text-gray-400">
                    Generador de Tokens: <strong className="text-gray-800  dark:text-gray-400">{peerId}</strong>
                </div>
                <button
                    className="border border-green-200 bg-green-300 text-green-800 dark:bg-green-800 hover:text-green-200 dark:text-green-200 px-4 py-2  mt-4 rounded bg-green-300 text-white px-4 py-2 rounded hover:bg-green-700 focus:bg-green-500 transition duration-300 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50"
                    onClick={copiarIdAlPortapapeles}
                >
                    Copiar ID
                </button>
                {copiado ? <span className="text-sm">{copiado}</span> : null}
            </div>

            <div className="flex flex-col justify-between items-center gap-2 mb-4">
                <div className="flex flex-col justify-between items-center gap-2 mb-4">
                    <label
                        className="block text-gray-600 dark:text-gray-200 mb-2"
                        htmlFor="usuario"
                    >
                        Conexión:
                    </label>
                    {connectR ? <span className="text-sm">{connectR}</span> : null}
                    <input
                        className="border rounded w-full py-2 px-3 pl-10 pr-10 resize text-gray-600 dark:text-gray-200 bg-gray-300 dark:bg-gray-700"
                        id="conexion"
                        type="text"
                        value={remotePeerId}
                        onChange={(e) => setRemotePeerId(e.target.value)}
                        placeholder="Ingresa el ID Validador"
                    />
                    <button
                        className="border border-green-200 bg-green-300 dark:bg-green-800 px-4 py-2 rounded hover:bg-green-700 hover:text-green-200 focus:bg-green-500"
                        onClick={conectarConPeer}
                    >
                        Conectar
                    </button>
                </div>

            </div>
            <div className="border-t pt-4">
                <div className="mb-4">
                    <button
                        onClick={toggleAcordeon1}
                        className="flex justify-between items-center w-full"
                    >
                        <div className="flex items-center">
                            <div className="bg-blue-500 h-6 w-6 rounded-full mr-2"></div>
                            <span>Archivos</span>
                        </div>
                    </button>
                    {isOpenAcordeon1 && (
                        <p className="mt-2 text-gray-600">
                            <div className="chat flex flex-col">
                                {mensajesChat.map((mensaje, index) => (
                                    <div
                                        key={index}
                                        className={`mensaje p-2 rounded-lg my-1 ${mensaje.tipo === "recibido"
                                                ? "bg-gray-300 text-black self-start"
                                                : "bg-green-500 text-white self-end"
                                            }`}
                                    >
                                        {mensaje.texto}
                                    </div>
                                ))}
                                <button
                                className="bg-red-800 text-center text-white hover:bg-red-700 focus:bg-red-600 rounded-lg shadow-md px-2 py-2 w-10"
                                onClick={limpiarChat}
                              >
                                <svg 
                                  width="20" 
                                  height="20" 
                                  viewBox="0 0 24 24" 
                                  fill="none" 
                                  xmlns="http://www.w3.org/2000/svg"
                                >
                                  <path 
                                    d="M3 6H5H21" 
                                    stroke="white" 
                                    strokeWidth="2" 
                                    strokeLinecap="round" 
                                    strokeLinejoin="round"
                                  />
                                  <path 
                                    d="M8 6V4C8 3.46957 8.21071 2.96086 8.58579 2.58579C8.96086 2.21071 9.46957 2 10 2H14C14.5304 2 15.0391 2.21071 15.4142 2.58579C15.7893 2.96086 16 3.46957 16 4V6M19 6V20C19 20.5304 18.7893 21.0391 18.4142 21.4142C18.0391 21.7893 17.5304 22 17 22H7C6.46957 22 5.96086 21.7893 5.58579 21.4142C5.21071 21.0391 5 20.5304 5 20V6H19ZM10 11V17M14 11V17" 
                                    stroke="white" 
                                    strokeWidth="2" 
                                    strokeLinecap="round" 
                                    strokeLinejoin="round"
                                  />
                                </svg>
                              </button>
                            </div>
                        </p>
                    )}
                </div>

                <div className="relative">
                    <form onSubmit={enviarMensaje}>
                        <label
                            className="block text-gray-600 dark:text-gray-200 mb-2"
                            htmlFor="usuario"
                        >
                            Comentario:
                        </label>
                        <textarea
                            className="border rounded w-full py-2 px-3 pl-10 pr-10 resize text-gray-600 dark:text-gray-200 bg-gray-300 dark:bg-gray-700"
                            id="mensaje"
                            value={mensaje}
                            onKeyDown={handleKeyDown}
                            onChange={(e) => setMensaje(e.target.value)}
                            placeholder="Escribe un comentario"
                        //style={{ resize: "none" }} // Evitar que se redimensione el textarea
                        />
                        <button
                            className="border border-green-200 bg-green-300 dark:bg-green-800 mx-2 my-2 hover:bg-green-700 hover:text-green-200 focus:bg-green-500 p-1 rounded-lg shadow-md absolute bottom-2 right-2"
                            type="submit"
                        >
                            <svg
                                width="20"
                                height="20"
                                viewBox="0 0 20 20"
                                fill="none"
                                xmlns="http://www.w3.org/2000/svg"
                            >
                                <path d="M5 5L15 10L5 15V5Z" fill="white" />
                            </svg>
                        </button>
                    </form>
                </div>

                <div className="mb-4">
                    <button
                        onClick={toggleAcordeon2}
                        className="flex justify-between items-center w-full"
                    >
                        <div className="flex items-center">
                            <div className="bg-blue-500 h-6 w-6 rounded-full mr-2"></div>
                            <span>Información</span>
                        </div>
                    </button>
                    {isOpenAcordeon2 && (
                        <p className="mt-2 text-gray-600">
                            {mensajeR ? mensajeR : "No hay datos"}
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
};

export default Chat;
