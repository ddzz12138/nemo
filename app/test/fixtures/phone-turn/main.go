// Disposable TURN REST fixture. Binds one private PC interface and permits
// only peers at that same address. Never a public relay or Nemo service.
package main
import (
 "bufio"
 "crypto/hmac"
 "crypto/sha1"
 "encoding/base64"
 "encoding/json"
 "fmt"
 "net"
 "os"
 "strconv"
 "strings"
 "time"
 "github.com/pion/turn/v5"
)
func main(){if err:=run();err!=nil{fmt.Fprintln(os.Stderr,err);os.Exit(1)}}
func run()error{
 scanner:=bufio.NewScanner(os.Stdin);if !scanner.Scan(){return fmt.Errorf("missing fixture secret")}
 var input struct{SharedSecret string `json:"sharedSecret"`};if err:=json.Unmarshal(scanner.Bytes(),&input);err!=nil{return err};if len(input.SharedSecret)<32{return fmt.Errorf("invalid fixture secret")}
 addresses,err:=net.InterfaceAddrs();if err!=nil{return err};var bind net.IP
 for _,address:=range addresses{if network,ok:=address.(*net.IPNet);ok&&network.IP.To4()!=nil&&network.IP.IsPrivate()&&!network.IP.IsLoopback(){if bind==nil||network.IP.To4()[0]==192{bind=network.IP.To4()}}}
 if bind==nil{return fmt.Errorf("no private interface")}
 listener,err:=net.ListenPacket("udp4",net.JoinHostPort(bind.String(),"0"));if err!=nil{return err};defer listener.Close()
 realm:="nemo-synthetic"
 server,err:=turn.NewServer(turn.ServerConfig{Realm:realm,AuthHandler:func(request *turn.RequestAttributes)(string,[]byte,bool){
   username:=request.Username
   expiry,err:=strconv.ParseInt(strings.Split(username,":")[0],10,64);if err!=nil||expiry<time.Now().Unix()||expiry>time.Now().Unix()+900{return "",nil,false}
   mac:=hmac.New(sha1.New,[]byte(input.SharedSecret));mac.Write([]byte(username));password:=base64.StdEncoding.EncodeToString(mac.Sum(nil));return username,turn.GenerateAuthKey(username,request.Realm,password),true
 },PacketConnConfigs:[]turn.PacketConnConfig{{PacketConn:listener,RelayAddressGenerator:&turn.RelayAddressGeneratorStatic{RelayAddress:bind,Address:bind.String()},PermissionHandler:func(_ net.Addr,peer net.IP)bool{return peer.Equal(bind)}}}})
 if err!=nil{return err};defer server.Close()
 if err:=json.NewEncoder(os.Stdout).Encode(map[string]any{"url":"turn:"+listener.LocalAddr().String()+"?transport=udp"});err!=nil{return err}
 done:=make(chan struct{});go func(){scanner.Scan();close(done)}();select{case<-done:case<-time.After(180*time.Second):}
 return nil
}
