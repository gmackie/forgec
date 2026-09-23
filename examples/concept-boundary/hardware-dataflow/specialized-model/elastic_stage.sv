// One clock domain, synchronous active-high reset. Reset discards pending data.
module elastic_stage (
  input wire clk, reset,
  input wire in_valid,
  output wire in_ready,
  input wire [7:0] in_data,
  output reg out_valid,
  input wire out_ready,
  output reg [7:0] out_data
);
  assign in_ready = !out_valid || out_ready;
  always @(posedge clk) begin
    if (reset) begin
      out_valid <= 0;
      out_data <= 0;
    end else if (in_ready) begin
      out_valid <= in_valid;
      if (in_valid) out_data <= in_data;
    end
  end
endmodule
